//! Linux's Window menu cannot use Tauri's predefined window items: muda's GTK
//! backend silently omits Minimize, Maximize and Close Window, leaving an empty
//! popup on both Wayland and X11. Use ordinary items and native window APIs.

use tauri::menu::{Menu, MenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Manager, Runtime};

const MINIMIZE: &str = "window.minimize";
const MAXIMIZE: &str = "window.maximize";
const CLOSE: &str = "window.close";

/// Replaces Tauri's unsupported Linux submenu, preserving its position.
pub fn install<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let minimize = MenuItem::with_id(app, MINIMIZE, "Minimize", true, None::<&str>)?;
    let maximize = MenuItem::with_id(app, MAXIMIZE, "Maximize / Restore", true, None::<&str>)?;
    // Ctrl+W belongs to Close Tab, not Close Window.
    let close = MenuItem::with_id(app, CLOSE, "Close Window", true, None::<&str>)?;
    let replacement = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&minimize, &maximize, &close],
    )?;
    if let Some(index) = menu
        .items()?
        .iter()
        .position(|item| item.id().as_ref() == WINDOW_SUBMENU_ID)
    {
        menu.remove_at(index)?;
        menu.insert(&replacement, index)?;
    } else {
        menu.append(&replacement)?;
    }
    Ok(())
}

/// Handles only window actions, targeting the focused window (including Mini).
/// A missing focus falls back to the main window, as workspace menu actions do.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str, main_window_label: &str) -> bool {
    if !matches!(id, MINIMIZE | MAXIMIZE | CLOSE) {
        return false;
    }
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(main_window_label));
    if let Some(window) = window {
        let result = match id {
            MINIMIZE => window.minimize(),
            MAXIMIZE => window.is_maximized().and_then(|maximized| {
                if maximized {
                    window.unmaximize()
                } else {
                    window.maximize()
                }
            }),
            // close(), rather than destroy(), preserves CloseRequested handlers.
            CLOSE => window.close(),
            _ => unreachable!(),
        };
        if let Err(error) = result {
            log::error!("Window menu action {id} failed: {error}");
        }
    }
    true
}
