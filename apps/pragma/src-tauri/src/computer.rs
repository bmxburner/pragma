//! Desktop side of computer use: the visible half of the safety model.
//!
//! The local host's `pragma-server` owns sessions, leases, policy, and the
//! native helper. This module forwards the desktop user's own requests (always
//! attributed as `user`, so approvals and the stop can only come from here),
//! bridges the `computerActivity` stream into the webviews, and owns the one
//! kind of window that must live outside the app: a transparent,
//! click-through overlay per display that draws the agent cursor over other
//! apps. Overlays exist exactly while a session is live. The
//! picture-in-picture view is an in-app panel in the main window, not a window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use pragma_client::request_subscribe;
use pragma_constants::{
    ComputerActivitySnapshot, ComputerDisplay, ProtocolEventKind, ProtocolRpcMethod, CONSTANTS,
};
use pragma_protocol::{read_frame, write_json_frame, EventFrame, Frame, ServerFrame};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::hosts::Hosts;
use crate::pty::PtyClient;

/// Frontend event carrying `{ kind: "snapshot" | "delta", payload }`.
const ACTIVITY_EVENT: &str = "pragma:computer";
/// Label prefix of the per-display cursor overlays.
const OVERLAY_PREFIX: &str = "computer-overlay-";

fn app_url(app: &AppHandle, fragment: &str) -> WebviewUrl {
    crate::updates::active_ui_overlay_url(app).map_or_else(
        || WebviewUrl::App(format!("index.html#{fragment}").into()),
        |mut url| {
            url.set_fragment(Some(fragment));
            WebviewUrl::External(url)
        },
    )
}

/// One `computer` RPC from the desktop user.
///
/// The caller is always overwritten with `user`: this command is the only
/// path that may approve a prompt, pause, or stop, and a payload must not be
/// able to claim to be anyone else.
#[tauri::command(async)]
pub fn computer_rpc(hosts: State<'_, Hosts>, mut payload: Value) -> AppResult<Value> {
    if !payload.is_object() {
        return Err(AppError::InvalidInput(
            "computer request must be an object".to_string(),
        ));
    }
    payload["caller"] = json!({ "kind": "user", "label": "You" });
    hosts.local().rpc(ProtocolRpcMethod::Computer, payload)
}

/// Starts the activity bridge for the local host and registers the
/// emergency-stop shortcut.
pub fn start(app: AppHandle, pty: PtyClient) {
    thread::spawn(move || {
        let overlays = AtomicBool::new(false);
        loop {
            if let Err(error) = subscribe_once(&app, &pty, &overlays) {
                log::warn!("computer activity bridge disconnected: {error}");
                thread::sleep(Duration::from_millis(500));
            }
        }
    });
}

fn subscribe_once(app: &AppHandle, pty: &PtyClient, overlays: &AtomicBool) -> Result<(), String> {
    let mut stream = pty
        .connect_with_spawn()
        .map_err(|error| error.to_string())?;
    let request = request_subscribe(ProtocolEventKind::ComputerActivity, None, None);
    write_json_frame(&mut stream, &request).map_err(|error| error.to_string())?;
    let mut live_sessions: usize = 0;
    loop {
        let Frame::Json(bytes) = read_frame(&mut stream).map_err(|error| error.to_string())? else {
            continue;
        };
        match serde_json::from_slice::<ServerFrame>(&bytes) {
            Ok(ServerFrame::Response(response)) if response.request_id == request.request_id => {
                if !response.ok {
                    return Err(response
                        .error
                        .unwrap_or_else(|| "computer subscription rejected".to_string()));
                }
                // Mostly idle: the connect-time read timeout would read as a drop.
                stream
                    .set_read_timeout(None)
                    .map_err(|error| error.to_string())?;
            }
            Ok(ServerFrame::Event(EventFrame::Snapshot { payload, .. })) => {
                live_sessions = serde_json::from_value::<ComputerActivitySnapshot>(payload.clone())
                    .map_or(0, |snapshot| snapshot.sessions.len());
                sync_overlays(app, live_sessions > 0, overlays);
                let _ = app.emit(
                    ACTIVITY_EVENT,
                    json!({ "kind": "snapshot", "payload": payload }),
                );
            }
            Ok(ServerFrame::Event(EventFrame::Delta { payload, .. })) => {
                match payload["type"].as_str() {
                    Some("sessionStarted") => live_sessions += 1,
                    Some("sessionEnded") => live_sessions = live_sessions.saturating_sub(1),
                    _ => {}
                }
                sync_overlays(app, live_sessions > 0, overlays);
                let _ = app.emit(
                    ACTIVITY_EVENT,
                    json!({ "kind": "delta", "payload": payload }),
                );
            }
            _ => {}
        }
    }
}

/// Creates one overlay per display while any session is live, and closes
/// them all when the last one ends.
fn sync_overlays(app: &AppHandle, wanted: bool, open: &AtomicBool) {
    if wanted == open.load(Ordering::SeqCst) {
        return;
    }
    if !wanted || !cursor_enabled(app) {
        open.store(false, Ordering::SeqCst);
        for (label, window) in app.webview_windows() {
            if label.starts_with(OVERLAY_PREFIX) {
                let _ = window.close();
            }
        }
        return;
    }
    let displays: Vec<ComputerDisplay> = app
        .state::<Hosts>()
        .local()
        .rpc(
            ProtocolRpcMethod::Computer,
            json!({ "op": "displays", "caller": { "kind": "user" } }),
        )
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    // Marked open only once there is something to draw on: a failed display
    // read (the helper restarting) is retried on the next event instead of
    // leaving the session without a cursor.
    open.store(!displays.is_empty(), Ordering::SeqCst);
    for (index, display) in displays.iter().enumerate() {
        let label = format!("{OVERLAY_PREFIX}{index}");
        let fragment = format!(
            "computer-overlay={}&x={}&y={}",
            urlencode(&display.id),
            display.frame.x,
            display.frame.y
        );
        let built = WebviewWindowBuilder::new(app, &label, app_url(app, &fragment))
            .title("Computer use cursor")
            .position(display.frame.x, display.frame.y)
            .inner_size(display.frame.w, display.frame.h)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .content_protected(true)
            .disable_drag_drop_handler()
            .build();
        match built {
            Ok(window) => {
                // Click-through: the overlay only ever draws.
                let _ = window.set_ignore_cursor_events(true);
            }
            Err(error) => log::warn!("could not open the computer-use overlay: {error}"),
        }
    }
}

/// `computerUse.showCursor` from the global config; on unless set to `false`.
fn cursor_enabled(app: &AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return true;
    };
    std::fs::read_to_string(home.join(&CONSTANTS.plugins.config_file_name))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|config| config["computerUse"]["showCursor"].as_bool())
        .unwrap_or(true)
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// The emergency-stop chord: ⌃⌥⌘. on macOS, Ctrl+Alt+Shift+Esc elsewhere.
pub fn emergency_stop_shortcut() -> &'static str {
    if cfg!(target_os = "macos") {
        "Control+Alt+Super+Period"
    } else {
        "Control+Alt+Shift+Escape"
    }
}

/// Runs the emergency stop against the local host.
pub fn emergency_stop(app: &AppHandle) {
    let result = app.state::<Hosts>().local().rpc(
        ProtocolRpcMethod::Computer,
        json!({ "op": "stop", "caller": { "kind": "user" } }),
    );
    if let Err(error) = result {
        log::warn!("computer-use emergency stop failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_ids_are_url_safe() {
        assert_eq!(urlencode("display:mac:5"), "display%3Amac%3A5");
    }
}
