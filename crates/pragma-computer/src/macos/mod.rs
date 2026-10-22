//! The macOS backend: Accessibility for reading and element actions, `CGEvent`
//! for pointer and keyboard input, `NSWorkspace` for apps, and `xcap` for
//! windows, displays, and capture.
//!
//! Element actions (`AXPress`, setting `AXValue`) are preferred because they
//! work on background windows and never move the physical cursor. Pointer and
//! keyboard paths activate the target, check it really is frontmost, and only
//! then post events; a mismatch is `targetChanged`, never a click elsewhere.

mod apps;
mod ffi;
mod input;
mod responsible;
mod walk;

use std::time::{Duration, Instant};

use objc2_app_kit::NSApplicationActivationOptions;
use objc2_core_foundation::CGPoint;
use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerElement, ComputerErrorCode, ComputerFocusRequest, ComputerImageFormat,
    ComputerInspectRequest, ComputerKeyRequest, ComputerMethod, ComputerMouseButton,
    ComputerMoveRequest, ComputerOpenRequest, ComputerPermissionState, ComputerPermissions,
    ComputerPoint, ComputerRect, ComputerScreenshot, ComputerScreenshotRequest,
    ComputerScrollDirection, ComputerScrollRequest, ComputerSnapshot, ComputerTypeRequest,
    ComputerWindow, ComputerWindowsRequest, CONSTANTS,
};
use pragma_core::computer::{
    matches_query, parse_chord, parse_point, rect_center, revalidate, snapshot_id, ChordPlatform,
    Modifier, Revalidation,
};

use self::apps::Running;
use self::ffi::Element;
pub use self::responsible::run_as_own_identity;
use crate::capture::{self, CaptureOutput, CaptureTarget};
use crate::snapshot::{normalize_role, SnapshotRing, WalkLimits};
use crate::{
    failure, ComputerBackend, ComputerResult, Context, Focused, Performed, ResolveRequest, Resolved,
};

/// Seconds any one app may take to answer an accessibility message.
const AX_TIMEOUT_SECONDS: f32 = 1.0;
/// How long activation may take before the target counts as refused.
const ACTIVATE_WAIT: Duration = Duration::from_millis(1500);

/// The macOS backend.
#[derive(Default)]
pub struct MacBackend {
    ring: SnapshotRing<Element>,
}

impl MacBackend {
    /// A backend with an empty snapshot ring.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

fn pid_i32(pid: u64) -> i32 {
    i32::try_from(pid).unwrap_or(0)
}

// ------------------------------------------------------------------ apps

fn matches_app(app: &ComputerApp, query: &str) -> bool {
    let query = query.trim();
    app.name.eq_ignore_ascii_case(query)
        || app.id.eq_ignore_ascii_case(query)
        || app
            .bundle_id
            .as_deref()
            .is_some_and(|id| id.eq_ignore_ascii_case(query))
        || app
            .path
            .as_deref()
            .is_some_and(|path| path.eq_ignore_ascii_case(query))
}

/// The running app a request names (by pid, name, id, bundle id, or path), or
/// the frontmost app when it names none.
fn running_app(app: Option<&str>, pid: Option<u64>) -> ComputerResult<Running> {
    let mut running = apps::running();
    let index = match (pid, app) {
        (Some(pid), _) => running.iter().position(|r| r.app.pid == Some(pid)),
        (None, Some(name)) => running
            .iter()
            .position(|r| matches_app(&r.app, name))
            .or_else(|| {
                // A unique case-insensitive prefix ("text" → TextEdit) is fine; an
                // ambiguous one is not guessed at.
                let lower = name.to_lowercase();
                let hits: Vec<usize> = running
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.app.name.to_lowercase().starts_with(&lower))
                    .map(|(index, _)| index)
                    .collect();
                (hits.len() == 1).then(|| hits[0])
            }),
        (None, None) => running.iter().position(|r| r.app.frontmost),
    };
    match index {
        Some(index) => Ok(running.swap_remove(index)),
        None => Err(failure(
            ComputerErrorCode::AppNotFound,
            match (pid, app) {
                (Some(pid), _) => format!("no running app has pid {pid}"),
                (None, Some(name)) => format!("`{name}` is not running; open it first"),
                (None, None) => "no app is frontmost".to_string(),
            },
        )),
    }
}

fn frontmost_pid() -> Option<i32> {
    apps::frontmost_pid()
}

/// Brings `app` to the front and waits until it is.
///
/// macOS 14's cooperative activation can refuse a background process's
/// request, so the AX `AXFrontmost` attribute is set as well; it is honoured
/// under the Accessibility grant.
fn activate(app: &Running) -> ComputerResult<()> {
    let pid = app.handle.processIdentifier();
    if frontmost_pid() == Some(pid) {
        return Ok(());
    }
    if app.handle.isHidden() {
        app.handle.unhide();
    }
    app.handle
        .activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
    let element = ffi::application(pid);
    ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
    let _ = ffi::set_bool(&element, "AXFrontmost", true);
    let started = Instant::now();
    while started.elapsed() < ACTIVATE_WAIT {
        if frontmost_pid() == Some(pid) {
            // Give the app a beat to route key focus to its window.
            std::thread::sleep(Duration::from_millis(60));
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    Err(failure(
        ComputerErrorCode::TargetChanged,
        format!("{} did not come to the front", app.app.name),
    ))
}

fn require_frontmost(app: &Running) -> ComputerResult<()> {
    if frontmost_pid() == Some(app.handle.processIdentifier()) {
        Ok(())
    } else {
        Err(failure(
            ComputerErrorCode::TargetChanged,
            format!("{} is no longer frontmost", app.app.name),
        ))
    }
}

// ------------------------------------------------------------------ windows

/// On-screen windows of regular apps, front to back.
///
/// Only layer-0 windows owned by a regular app count; the Window Server's
/// menu bar, the Dock, and status items are system surfaces, not targets.
fn listed_windows(running: &[Running]) -> Vec<ComputerWindow> {
    let front = frontmost_pid();
    let displays = capture::displays().unwrap_or_default();
    let mut focused_taken = false;
    ffi::window_list()
        .into_iter()
        .filter(|info| info.layer == 0 && info.w > 1.0 && info.h > 1.0)
        .filter_map(|info| {
            let pid = u64::try_from(info.pid).ok()?;
            let owner = running.iter().find(|r| r.app.pid == Some(pid))?;
            let frame = ComputerRect {
                x: info.x,
                y: info.y,
                w: info.w,
                h: info.h,
                display_id: display_of(&displays, info.x + info.w / 2.0, info.y + info.h / 2.0),
            };
            // The list is front to back, so the frontmost app's first window
            // is the focused one.
            let focused = !focused_taken && Some(info.pid) == front;
            focused_taken |= focused;
            Some(ComputerWindow {
                id: capture::window_id(info.id),
                app_id: owner.app.id.clone(),
                app_name: owner.app.name.clone(),
                pid,
                title: info.title.unwrap_or_default(),
                frame,
                focused,
                minimized: false,
                on_screen: true,
            })
        })
        .collect()
}

fn display_of(displays: &[ComputerDisplay], x: f64, y: f64) -> Option<String> {
    let point = ComputerPoint { x, y };
    displays
        .iter()
        .find(|display| pragma_core::computer::rect_contains(&display.frame, &point))
        .map(|display| display.id.clone())
}

fn display_rects() -> Vec<ComputerRect> {
    capture::displays()
        .map(|displays| displays.into_iter().map(|display| display.frame).collect())
        .unwrap_or_default()
}

/// The AX window element a request targets: the one matching `window_id`'s
/// frame and title, else the app's focused or main window, else its first.
fn ax_window(
    app_element: &Element,
    pid: u64,
    window_id: Option<&str>,
) -> ComputerResult<(Element, Option<ComputerWindow>)> {
    let windows = ffi::elements(app_element, "AXWindows");
    let listed: Vec<ComputerWindow> = listed_windows(&apps::running())
        .into_iter()
        .filter(|w| w.pid == pid)
        .collect();
    if let Some(id) = window_id {
        let target = listed.iter().find(|w| w.id == id).ok_or_else(|| {
            failure(
                ComputerErrorCode::WindowNotFound,
                format!("no window `{id}` for that app"),
            )
        })?;
        let element = windows
            .iter()
            .find(|candidate| same_window(candidate, target))
            .cloned()
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    format!("window `{id}` has no accessibility element"),
                )
            })?;
        return Ok((element, Some(target.clone())));
    }
    let element = ffi::element(app_element, "AXFocusedWindow")
        .or_else(|| ffi::element(app_element, "AXMainWindow"))
        .or_else(|| windows.first().cloned())
        .ok_or_else(|| {
            failure(
                ComputerErrorCode::WindowNotFound,
                "the app has no open window",
            )
        })?;
    let matched = listed.into_iter().find(|w| same_window(&element, w));
    Ok((element, matched))
}

fn same_window(element: &Element, window: &ComputerWindow) -> bool {
    let (Some(origin), Some(size)) = (ffi::position(element), ffi::size(element)) else {
        return false;
    };
    let close = |a: f64, b: f64| (a - b).abs() <= 2.0;
    close(origin.x, window.frame.x)
        && close(origin.y, window.frame.y)
        && close(size.width, window.frame.w)
        && close(size.height, window.frame.h)
}

// ------------------------------------------------------------------ elements

/// A stored element resolved against the live tree.
struct Live {
    pid: u64,
    handle: Element,
    element: ComputerElement,
}

fn live_frame(handle: &Element) -> Option<ComputerRect> {
    let origin = ffi::position(handle)?;
    let size = ffi::size(handle)?;
    Some(ComputerRect {
        x: origin.x,
        y: origin.y,
        w: size.width,
        h: size.height,
        display_id: None,
    })
}

fn to_cg(point: &ComputerPoint) -> CGPoint {
    CGPoint {
        x: point.x,
        y: point.y,
    }
}

fn modifiers(names: &[String]) -> ComputerResult<Vec<Modifier>> {
    names
        .iter()
        .map(|name| {
            parse_chord(&format!("{name}+a"), ChordPlatform::Mac)
                .map(|chord| chord.modifiers)
                .map_err(|message| failure(ComputerErrorCode::InvalidPayload, message))
        })
        .collect::<ComputerResult<Vec<_>>>()
        .map(|all| all.into_iter().flatten().collect())
}

impl MacBackend {
    /// Resolves `id` to a live element: the stored handle when it still reads
    /// as the same control, else a fresh walk of its window and §5.3's
    /// revalidation.
    fn live(&mut self, id: &str) -> ComputerResult<Live> {
        let (stored, index) = self.ring.lookup(id)?;
        let pid = stored.pid;
        let element = stored.elements[index].clone();
        let handle = stored.handles[index].clone();
        let window_id = stored.window_id.clone();
        let role = ffi::string(&handle, "AXRole").map(|role| normalize_role(&role));
        if role.as_deref() == Some(element.role.as_str()) {
            let mut element = element;
            element.frame = live_frame(&handle).or(element.frame);
            return Ok(Live {
                pid,
                handle,
                element,
            });
        }
        let app_element = ffi::application(pid_i32(pid));
        ffi::set_timeout(&app_element, AX_TIMEOUT_SECONDS);
        let (window, _) = ax_window(&app_element, pid, window_id.as_deref())?;
        let seq = self.ring.next_seq();
        let walked = walk::walk(
            &window,
            seq,
            &WalkLimits::new(None, None, true),
            &display_rects(),
        );
        match revalidate(&element, &walked.elements) {
            Revalidation::SamePath(found) | Revalidation::Moved(found) => Ok(Live {
                pid,
                handle: walked.handles[found].clone(),
                element: walked.elements[found].clone(),
            }),
            Revalidation::Stale(similar) => {
                let candidates: Vec<serde_json::Value> = similar
                    .iter()
                    .filter_map(|&i| walked.elements.get(i))
                    .map(|candidate| serde_json::json!({ "label": candidate.label, "role": candidate.role }))
                    .collect();
                let mut stale = failure(
                    ComputerErrorCode::ElementStale,
                    format!(
                        "`{id}` ({} “{}”) is no longer on screen",
                        element.role, element.label
                    ),
                );
                stale.hint = Some("Run `inspect` again and use a fresh element id.".to_string());
                stale.details.insert(
                    "candidates".to_string(),
                    serde_json::Value::Array(candidates),
                );
                Err(stale)
            }
        }
    }

    /// The live element's centre, after checking nothing covers it.
    fn hit_point(live: &Live) -> ComputerResult<ComputerPoint> {
        let frame = live.element.frame.as_ref().ok_or_else(|| {
            failure(
                ComputerErrorCode::ElementNotFound,
                "the element has no on-screen frame",
            )
        })?;
        let center = rect_center(frame);
        #[allow(clippy::cast_possible_truncation)]
        let hit = ffi::element_at(&ffi::system_wide(), center.x as f32, center.y as f32);
        let owner = hit.as_ref().and_then(|hit| ffi::pid(hit));
        if owner.is_some_and(|owner| i64::from(owner) != i64::try_from(live.pid).unwrap_or(-1)) {
            return Err(failure(
                ComputerErrorCode::TargetChanged,
                "something else is covering the element; run inspect again",
            ));
        }
        Ok(center)
    }

    fn point_for(
        &mut self,
        element: Option<&str>,
        x: Option<f64>,
        y: Option<f64>,
    ) -> ComputerResult<(ComputerPoint, Option<Live>)> {
        if let Some(id) = element {
            let live = self.live(id)?;
            let point = Self::hit_point(&live)?;
            return Ok((point, Some(live)));
        }
        match (x, y) {
            (Some(x), Some(y)) => Ok((ComputerPoint { x, y }, None)),
            _ => Err(failure(
                ComputerErrorCode::InvalidPayload,
                "give an element id or both x and y",
            )),
        }
    }

    fn endpoint(&mut self, text: &str) -> ComputerResult<ComputerPoint> {
        if let Some(point) = parse_point(text) {
            return Ok(point);
        }
        let live = self.live(text)?;
        Self::hit_point(&live)
    }

    fn app_for_live(live: &Live) -> ComputerResult<Running> {
        running_app(None, Some(live.pid))
    }
}

fn screen_permission(request: bool) -> ComputerPermissionState {
    let granted = if request {
        objc2_core_graphics::CGRequestScreenCaptureAccess()
    } else {
        objc2_core_graphics::CGPreflightScreenCaptureAccess()
    };
    if granted {
        ComputerPermissionState::Granted
    } else {
        ComputerPermissionState::Denied
    }
}

impl ComputerBackend for MacBackend {
    fn permissions(&mut self, request: bool) -> ComputerResult<ComputerPermissions> {
        let accessibility = if ffi::is_trusted(request) {
            ComputerPermissionState::Granted
        } else {
            ComputerPermissionState::Denied
        };
        Ok(ComputerPermissions {
            platform: crate::platform_name().to_string(),
            supported: true,
            accessibility,
            screen_recording: screen_permission(request),
        })
    }

    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>> {
        capture::displays()
    }

    fn apps(&mut self, request: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>> {
        let all = if request.installed == Some(true) {
            apps::installed()
        } else {
            apps::running().into_iter().map(|r| r.app).collect()
        };
        let query = request.query.as_deref().unwrap_or_default().to_lowercase();
        Ok(all
            .into_iter()
            .filter(|app| {
                query.is_empty()
                    || app.name.to_lowercase().contains(&query)
                    || app
                        .bundle_id
                        .as_deref()
                        .is_some_and(|id| id.to_lowercase().contains(&query))
            })
            .collect())
    }

    fn windows(&mut self, request: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>> {
        let running = apps::running();
        let windows = listed_windows(&running);
        if request.app.is_none() && request.pid.is_none() {
            return Ok(windows);
        }
        let app = running_app(request.app.as_deref(), request.pid)?;
        Ok(windows
            .into_iter()
            .filter(|w| Some(w.pid) == app.app.pid)
            .collect())
    }

    fn open(&mut self, ctx: &Context, request: &ComputerOpenRequest) -> ComputerResult<Focused> {
        let name = request.app.as_deref();
        // Resolve the name against the catalog so `open Safari` launches the
        // bundle, not whatever `open -a` happens to guess.
        let installed = apps::installed();
        let known =
            name.and_then(|name| installed.iter().find(|app| matches_app(app, name)).cloned());
        let bundle_id = known.as_ref().and_then(|app| app.bundle_id.clone());
        let path = known.as_ref().and_then(|app| app.path.clone());
        let documents: Vec<&str> = [request.url.as_deref(), request.file.as_deref()]
            .into_iter()
            .flatten()
            .collect();
        apps::launch(&apps::LaunchSpec {
            bundle_id: bundle_id.as_deref(),
            path: path.as_deref(),
            name,
            new_instance: request.new_instance == Some(true),
            activate: request.activate != Some(false),
            documents,
        })?;
        let wait = Duration::from_millis(
            request
                .wait_ready_ms
                .unwrap_or(CONSTANTS.computer.app_launch_wait_ms.get()),
        );
        let started = Instant::now();
        let lookup = bundle_id.as_deref().or(name);
        loop {
            ctx.stop.check()?;
            if let Ok(app) = running_app(lookup, None) {
                let element = ffi::application(app.handle.processIdentifier());
                ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
                let ready = app.handle.isFinishedLaunching()
                    && !ffi::elements(&element, "AXWindows").is_empty();
                if ready || started.elapsed() >= wait {
                    let window = app
                        .app
                        .pid
                        .and_then(|pid| ax_window(&element, pid, None).ok())
                        .and_then(|(_, window)| window);
                    return Ok(Focused {
                        app: app.app,
                        window,
                    });
                }
            } else if started.elapsed() >= wait {
                return Err(failure(
                    ComputerErrorCode::Timeout,
                    "the app did not finish launching in time",
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn focus(&mut self, _ctx: &Context, request: &ComputerFocusRequest) -> ComputerResult<Focused> {
        let app = running_app(request.app.as_deref(), request.pid)?;
        activate(&app)?;
        let pid = app.app.pid.unwrap_or(0);
        let element = ffi::application(pid_i32(pid));
        ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
        let (window, listed) = ax_window(&element, pid, request.window.as_deref())?;
        if request.window.is_some() {
            let _ = ffi::perform(&window, "AXRaise");
            let _ = ffi::set_bool(&window, "AXMain", true);
        }
        Ok(Focused {
            app: app.app,
            window: listed,
        })
    }

    fn inspect(&mut self, request: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot> {
        if !ffi::is_trusted(false) {
            return Err(permission_missing("accessibility"));
        }
        let started = Instant::now();
        let app = running_app(request.app.as_deref(), request.pid)?;
        let pid = app.app.pid.unwrap_or(0);
        let element = ffi::application(pid_i32(pid));
        ffi::set_timeout(&element, AX_TIMEOUT_SECONDS);
        let (window, listed) = ax_window(&element, pid, request.window.as_deref())?;
        let seq = self.ring.next_seq();
        let limits = WalkLimits::new(
            request.max_nodes.map(std::num::NonZero::get),
            request.max_depth.map(std::num::NonZero::get),
            request.include_offscreen == Some(true),
        );
        let walked = walk::walk(&window, seq, &limits, &display_rects());
        let query = request.query.as_deref().unwrap_or_default();
        let role = request.role.as_deref();
        let mut elements = Vec::new();
        let mut handles = Vec::new();
        let mut focused = None;
        for (index, (mut element, handle)) in
            walked.elements.into_iter().zip(walked.handles).enumerate()
        {
            if !matches_query(&element, query) || role.is_some_and(|role| role != element.role) {
                continue;
            }
            // Ids stay dense after filtering so `e0..eN` is the whole list.
            let dense = u32::try_from(elements.len()).unwrap_or(u32::MAX);
            element.id = pragma_core::computer::element_id(seq, dense);
            if walked.focused_index == Some(index) {
                focused = Some(element.id.clone());
            }
            elements.push(element);
            handles.push(handle);
        }
        self.ring.insert(
            seq,
            pid,
            listed.as_ref().map(|w| w.id.clone()),
            elements.clone(),
            handles,
        );
        Ok(ComputerSnapshot {
            id: snapshot_id(seq),
            app: app.app,
            window: listed,
            elements,
            focused_element_id: focused,
            truncated: walked.truncated,
            node_count: walked.node_count,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            created_at: now_ms(),
            untrusted: true,
        })
    }

    fn screenshot(
        &mut self,
        ctx: &Context,
        request: &ComputerScreenshotRequest,
    ) -> ComputerResult<ComputerScreenshot> {
        if !objc2_core_graphics::CGPreflightScreenCaptureAccess() {
            return Err(permission_missing("screenRecording"));
        }
        let target = if let Some(region) = &request.region {
            CaptureTarget::Region(region.clone())
        } else if let Some(display) = &request.display {
            CaptureTarget::Display {
                raw_id: display.rsplit(':').next().and_then(|raw| raw.parse().ok()),
            }
        } else if request.window.is_some() || request.app.is_some() || request.pid.is_some() {
            let running = apps::running();
            let windows = listed_windows(&running);
            let first = if let Some(id) = &request.window {
                windows.into_iter().find(|w| &w.id == id)
            } else {
                let app = running_app(request.app.as_deref(), request.pid)?;
                windows.into_iter().find(|w| Some(w.pid) == app.app.pid)
            }
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    "no on-screen window to capture",
                )
            })?;
            CaptureTarget::Window {
                raw_id: capture::parse_window_id(&first.id)
                    .ok_or_else(|| failure(ComputerErrorCode::WindowNotFound, "bad window id"))?,
                frame: first.frame,
            }
        } else {
            CaptureTarget::Display { raw_id: None }
        };
        capture::capture(
            &target,
            &CaptureOutput {
                format: request.format.unwrap_or(ComputerImageFormat::Png),
                max_width: request.max_width.and_then(|w| u32::try_from(w.get()).ok()),
                path: request.out.as_ref().map(std::path::PathBuf::from),
                directory: ctx.screenshots_dir.clone(),
                inline: request.base64 == Some(true),
            },
        )
    }

    fn resolve(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved> {
        if let Some(id) = &request.element {
            let live = self.live(id)?;
            let app = Self::app_for_live(&live)?;
            let point = live.element.frame.as_ref().map(rect_center);
            return Ok(Resolved {
                app: app.app,
                window: None,
                element: Some(live.element),
                point,
            });
        }
        let app = if request.app.is_none() && request.pid.is_none() {
            // A bare point resolves to whoever owns it.
            let owner = request.point.as_ref().and_then(|point| {
                #[allow(clippy::cast_possible_truncation)]
                let hit = ffi::element_at(&ffi::system_wide(), point.x as f32, point.y as f32)?;
                ffi::pid(&hit)
            });
            running_app(None, owner.and_then(|pid| u64::try_from(pid).ok()))?
        } else {
            running_app(request.app.as_deref(), request.pid)?
        };
        Ok(Resolved {
            app: app.app,
            window: None,
            element: None,
            point: request.point.clone(),
        })
    }

    fn click(
        &mut self,
        ctx: &Context,
        request: &ComputerClickRequest,
    ) -> ComputerResult<Performed> {
        let button = request.button.unwrap_or(ComputerMouseButton::Left);
        let count = u32::try_from(request.count.map_or(1, std::num::NonZero::get)).unwrap_or(1);
        let method = request.method.unwrap_or(ComputerMethod::Auto);
        let held = modifiers(&request.modifiers)?;
        if let Some(id) = &request.element {
            let live = self.live(id)?;
            let pressable = live.element.actions.iter().any(|action| action == "press");
            if method != ComputerMethod::Pointer
                && pressable
                && button == ComputerMouseButton::Left
                && count == 1
                && held.is_empty()
            {
                match ffi::perform(&live.handle, "AXPress") {
                    Ok(()) => {
                        return Ok(Performed {
                            method: ComputerMethod::Ax,
                            physical_cursor: false,
                            element: Some(live.element),
                        })
                    }
                    Err(_) if method == ComputerMethod::Ax => {
                        return Err(failure(
                            ComputerErrorCode::Internal,
                            "the app refused AXPress",
                        ));
                    }
                    Err(_) => {}
                }
            } else if method == ComputerMethod::Ax {
                return Err(failure(
                    ComputerErrorCode::InvalidPayload,
                    "that element has no press action",
                ));
            }
            let app = Self::app_for_live(&live)?;
            activate(&app)?;
            let point = Self::hit_point(&live)?;
            pointer_click(ctx, &app, &point, button, count, &held)?;
            return Ok(Performed {
                method: ComputerMethod::Pointer,
                physical_cursor: true,
                element: Some(live.element),
            });
        }
        let (point, _) = self.point_for(None, request.x, request.y)?;
        let app = self.resolve(&ResolveRequest {
            app: request.app.clone(),
            pid: request.pid,
            point: Some(point.clone()),
            ..ResolveRequest::default()
        })?;
        let running = running_app(None, app.app.pid)?;
        activate(&running)?;
        pointer_click(ctx, &running, &point, button, count, &held)?;
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: None,
        })
    }

    fn type_text(
        &mut self,
        ctx: &Context,
        request: &ComputerTypeRequest,
    ) -> ComputerResult<Performed> {
        let method = request.method.unwrap_or(ComputerMethod::Auto);
        let replace = request.replace == Some(true);
        let (app, element) = if let Some(id) = &request.element {
            let live = self.live(id)?;
            if live.element.secure && request.secret != Some(true) {
                return Err(failure(
                    ComputerErrorCode::ApprovalRequired,
                    "typing into a secure field needs --secret",
                ));
            }
            // Setting the value directly needs no focus and no keystrokes.
            if method != ComputerMethod::Keys
                && replace
                && live.element.editable
                && !live.element.secure
                && ffi::set_string(&live.handle, "AXValue", &request.text).is_ok()
            {
                {
                    let app = Self::app_for_live(&live)?;
                    if request.submit == Some(true) {
                        activate(&app)?;
                        input::press(&parse_chord("enter", ChordPlatform::Mac).map_err(invalid)?)?;
                    }
                    return Ok(Performed {
                        method: ComputerMethod::Ax,
                        physical_cursor: false,
                        element: Some(live.element),
                    });
                }
            }
            let app = Self::app_for_live(&live)?;
            activate(&app)?;
            let _ = ffi::set_bool(&live.handle, "AXFocused", true);
            (app, Some(live.element))
        } else {
            let app = running_app(request.app.as_deref(), request.pid)?;
            activate(&app)?;
            (app, None)
        };
        if method == ComputerMethod::Ax {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "that field cannot be set directly; use --method keys",
            ));
        }
        require_frontmost(&app)?;
        if replace {
            input::press(&parse_chord("cmd+a", ChordPlatform::Mac).map_err(invalid)?)?;
        }
        input::type_text(&ctx.stop, &request.text)?;
        if request.submit == Some(true) {
            ctx.stop.check()?;
            input::press(&parse_chord("enter", ChordPlatform::Mac).map_err(invalid)?)?;
        }
        Ok(Performed {
            method: ComputerMethod::Keys,
            physical_cursor: false,
            element,
        })
    }

    fn key(&mut self, ctx: &Context, request: &ComputerKeyRequest) -> ComputerResult<Performed> {
        let chords = request
            .chords
            .iter()
            .map(|chord| parse_chord(chord, ChordPlatform::Mac).map_err(invalid))
            .collect::<ComputerResult<Vec<_>>>()?;
        if chords.is_empty() {
            return Err(failure(
                ComputerErrorCode::InvalidPayload,
                "give at least one chord",
            ));
        }
        let app = running_app(request.app.as_deref(), request.pid)?;
        activate(&app)?;
        let repeat = request.repeat.map_or(1, std::num::NonZero::get);
        for _ in 0..repeat {
            for chord in &chords {
                ctx.stop.check()?;
                require_frontmost(&app)?;
                input::press(chord)?;
            }
        }
        Ok(Performed {
            method: ComputerMethod::Keys,
            physical_cursor: false,
            element: None,
        })
    }

    fn scroll(
        &mut self,
        ctx: &Context,
        request: &ComputerScrollRequest,
    ) -> ComputerResult<Performed> {
        let (point, live) = match (&request.element, request.x, request.y) {
            (None, None, None) => {
                // No target: scroll the middle of the app's front window.
                let app = running_app(request.app.as_deref(), request.pid)?;
                let pid = app.app.pid.unwrap_or(0);
                let element = ffi::application(pid_i32(pid));
                let (window, _) = ax_window(&element, pid, None)?;
                let frame = live_frame(&window).ok_or_else(|| {
                    failure(ComputerErrorCode::WindowNotFound, "the window has no frame")
                })?;
                (rect_center(&frame), None)
            }
            (element, x, y) => self.point_for(element.as_deref(), x, y)?,
        };
        let app = match &live {
            Some(live) => Self::app_for_live(live)?,
            None => running_app(request.app.as_deref(), request.pid)?,
        };
        activate(&app)?;
        let amount = i32::try_from(request.amount.map_or(3, std::num::NonZero::get)).unwrap_or(3);
        let (vertical, horizontal) = match request.direction {
            ComputerScrollDirection::Up => (amount, 0),
            ComputerScrollDirection::Down => (-amount, 0),
            ComputerScrollDirection::Left => (0, amount),
            ComputerScrollDirection::Right => (0, -amount),
        };
        input::move_to(to_cg(&point))?;
        input::scroll(&ctx.stop, vertical, horizontal)?;
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: live.map(|live| live.element),
        })
    }

    fn move_pointer(
        &mut self,
        _ctx: &Context,
        request: &ComputerMoveRequest,
    ) -> ComputerResult<Performed> {
        let (point, live) = self.point_for(request.element.as_deref(), request.x, request.y)?;
        let visual_only = request.visual_only == Some(true);
        if !visual_only {
            input::move_to(to_cg(&point))?;
        }
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: !visual_only,
            element: live.map(|live| live.element),
        })
    }

    fn drag(&mut self, ctx: &Context, request: &ComputerDragRequest) -> ComputerResult<Performed> {
        let from = self.endpoint(&request.from)?;
        let to = self.endpoint(&request.to)?;
        let owner = self.resolve(&ResolveRequest {
            app: request.app.clone(),
            pid: request.pid,
            point: Some(from.clone()),
            ..ResolveRequest::default()
        })?;
        let app = running_app(None, owner.app.pid)?;
        activate(&app)?;
        let held = modifiers(&request.modifiers)?;
        let duration = Duration::from_millis(request.duration_ms.unwrap_or(300));
        input::drag(&ctx.stop, to_cg(&from), to_cg(&to), duration, &held)?;
        Ok(Performed {
            method: ComputerMethod::Pointer,
            physical_cursor: true,
            element: None,
        })
    }

    fn seconds_since_user_input(&mut self) -> Option<f64> {
        Some(input::seconds_since_user_input())
    }
}

fn pointer_click(
    ctx: &Context,
    app: &Running,
    point: &ComputerPoint,
    button: ComputerMouseButton,
    count: u32,
    held: &[Modifier],
) -> ComputerResult<()> {
    require_frontmost(app)?;
    let restore = (count == 1).then(input::pointer_location).flatten();
    input::click(&ctx.stop, to_cg(point), button, count, held)?;
    // A single click puts the cursor back where the user left it.
    if let Some(restore) = restore {
        let _ = input::move_to(restore);
    }
    Ok(())
}

fn invalid(message: String) -> pragma_constants::ComputerFailure {
    failure(ComputerErrorCode::InvalidPayload, message)
}

fn permission_missing(permission: &str) -> pragma_constants::ComputerFailure {
    let mut missing = failure(
        ComputerErrorCode::PermissionMissing,
        format!("the computer-use helper does not have the {permission} permission"),
    );
    missing.hint = Some("Run `pragma-cli computer permissions --request`, then allow it in System Settings → Privacy & Security.".to_string());
    missing.details.insert(
        "permission".to_string(),
        serde_json::Value::String(permission.to_string()),
    );
    missing
}
