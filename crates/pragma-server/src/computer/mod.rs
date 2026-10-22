//! The host's computer-use engine: one `computer` RPC and one
//! `computerActivity` stream, with `pragma-cli computer`, `client.computer`,
//! and the desktop as callers of the same code.
//!
//! The native work happens in the supervised `pragma-computer` helper
//! ([`helper`]); this module owns everything around it: who may act
//! ([`policy`]), sessions and leases ([`sessions`]), and the activity every
//! caller sees ([`activity`]). Every mutating action follows one pipeline:
//! resolve the target → refuse blocked apps → authorize the caller (asking the
//! desktop user when the policy says `ask`) → approve sensitive controls →
//! take the app lease → take the input mutex when needed → announce the
//! pointer → act → record.

// Every fallible call here returns the shared `ComputerFailure` wire type,
// which is larger than clippy's threshold; failures are the cold path and
// are serialized at once (see the same allow in `pragma-computer`).
#![allow(clippy::result_large_err)]

pub mod activity;
pub mod helper;
pub mod policy;
pub mod sessions;

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pragma_computer::protocol::HelperOp;
use pragma_computer::{Focused, Performed, ResolveRequest, Resolved};
use pragma_constants::{
    ComputerAccess, ComputerActionResult, ComputerActivitySnapshot, ComputerActivityType,
    ComputerApp, ComputerApproval, ComputerApproveRequest, ComputerAppsRequest, ComputerCaller,
    ComputerCallerKind, ComputerClickRequest, ComputerDragRequest, ComputerEndRequest,
    ComputerErrorCode, ComputerFailure, ComputerFocusRequest, ComputerFrameRequest,
    ComputerImageFormat, ComputerInputLock, ComputerInspectRequest, ComputerKeyRequest,
    ComputerMethod, ComputerMoveRequest, ComputerOp, ComputerOpenRequest, ComputerPauseReason,
    ComputerPermissionsRequest, ComputerPoint, ComputerPointer, ComputerScreenshot,
    ComputerScreenshotRequest, ComputerScrollRequest, ComputerSession, ComputerSessionRequest,
    ComputerSnapshot, ComputerTarget, ComputerTypeRequest, ComputerUseSettings,
    ComputerWindowsRequest, CONSTANTS,
};
use pragma_core::computer::{
    app_key, caller_label, command_spec, failure, image_to_screen, is_blocked, is_enabled,
    is_sensitive_label, owner_key, redact_text, truncate_label, AppIdentity,
};
use pragma_protocol::EventFrame;
use serde::Deserialize;

use self::activity::{event, ActivityBus};
use self::helper::Helper;
use self::policy::{Policy, Verdict};
use self::sessions::{InputMutex, Sessions};

/// What the computer engine needs from the rest of the host.
pub trait ComputerHost {
    /// Whether a desktop app is connected to show the active-control indicator.
    fn desktop_connected(&self) -> bool;
    /// The agent reporting from `tab_id`, if any.
    fn agent_for_tab(&self, tab_id: &str) -> Option<String>;
}

/// One `computer` RPC: an attributed caller plus one operation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerRequest {
    #[serde(default)]
    pub caller: Option<ComputerCaller>,
    #[serde(flatten)]
    pub op: ComputerOpRequest,
}

/// The operation, tagged by `op`. Names match the CLI verbs and the SDK.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ComputerOpRequest {
    Apps(ComputerAppsRequest),
    Windows(ComputerWindowsRequest),
    Displays,
    Open(ComputerOpenRequest),
    Focus(ComputerFocusRequest),
    Inspect(ComputerInspectRequest),
    Screenshot(ComputerScreenshotRequest),
    Click(ComputerClickRequest),
    Type(ComputerTypeRequest),
    Key(ComputerKeyRequest),
    Scroll(ComputerScrollRequest),
    Move(ComputerMoveRequest),
    Drag(ComputerDragRequest),
    Status,
    End(ComputerEndRequest),
    Permissions(ComputerPermissionsRequest),
    Frame(ComputerFrameRequest),
    Approve(ComputerApproveRequest),
    Pause(ComputerSessionRequest),
    Unpause(ComputerSessionRequest),
    Stop(ComputerSessionRequest),
}

impl ComputerOpRequest {
    fn op(&self) -> ComputerOp {
        match self {
            Self::Apps(_) => ComputerOp::Apps,
            Self::Windows(_) => ComputerOp::Windows,
            Self::Displays => ComputerOp::Displays,
            Self::Open(_) => ComputerOp::Open,
            Self::Focus(_) => ComputerOp::Focus,
            Self::Inspect(_) => ComputerOp::Inspect,
            Self::Screenshot(_) => ComputerOp::Screenshot,
            Self::Click(_) => ComputerOp::Click,
            Self::Type(_) => ComputerOp::Type,
            Self::Key(_) => ComputerOp::Key,
            Self::Scroll(_) => ComputerOp::Scroll,
            Self::Move(_) => ComputerOp::Move,
            Self::Drag(_) => ComputerOp::Drag,
            Self::Status => ComputerOp::Status,
            Self::End(_) => ComputerOp::End,
            Self::Permissions(_) => ComputerOp::Permissions,
            Self::Frame(_) => ComputerOp::Frame,
            Self::Approve(_) => ComputerOp::Approve,
            Self::Pause(_) => ComputerOp::Pause,
            Self::Unpause(_) => ComputerOp::Unpause,
            Self::Stop(_) => ComputerOp::Stop,
        }
    }
}

/// One planned mutating action: what it targets, how it is worded in the
/// activity stream, how it expects to act, and the helper call that does it.
pub struct Action {
    target: ResolveRequest,
    verb: String,
    method: Option<ComputerMethod>,
    helper_op: HelperOp,
}

/// A request reached a dispatcher that does not handle it: a routing bug.
fn misrouted(request: &ComputerOpRequest) -> ComputerFailure {
    failure(
        ComputerErrorCode::Internal,
        format!("`{:?}` was routed to the wrong handler", request.op()),
    )
}

/// Milliseconds since the Unix epoch.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Screenshots kept for `click --screenshot` image-space coordinates.
const SHOT_MEMORY: usize = 64;
/// Physical input this recent means the user is using the machine right now.
const TAKEOVER_WINDOW_SECONDS: f64 = 0.3;
/// Extra time a helper call may take beyond the shipped per-action bound.
const CALL_SLACK: Duration = Duration::from_secs(2);

/// The computer-use engine.
pub struct ComputerService {
    helper: Arc<dyn Helper>,
    sessions: Mutex<Sessions>,
    input: InputMutex,
    policy: Policy,
    activity: Arc<ActivityBus>,
    stopped: AtomicBool,
    /// Owners the desktop user allowed "for this session".
    session_grants: Mutex<HashSet<String>>,
    shots: Mutex<VecDeque<(String, ComputerPoint, f64)>>,
    home: Option<PathBuf>,
}

impl ComputerService {
    /// The engine for a host whose state lives in `server_dir`, with the real
    /// supervised helper.
    pub fn new(server_dir: &std::path::Path) -> Arc<Self> {
        let activity = Arc::new(ActivityBus::default());
        let listener = {
            let activity = Arc::clone(&activity);
            Arc::new(move |status| {
                let mut helper_event = event(ComputerActivityType::HelperState);
                helper_event.helper = Some(status);
                activity.emit(helper_event);
            })
        };
        let helper = Arc::new(helper::ProcessHelper::new(
            server_dir.join(&CONSTANTS.computer.screenshots_directory),
            listener,
        ));
        Self::with_helper(
            server_dir,
            helper,
            activity,
            pragma_core::process_env::home_dir(),
        )
    }

    /// The engine over any helper; tests pass an in-process fake.
    pub fn with_helper(
        server_dir: &std::path::Path,
        helper: Arc<dyn Helper>,
        activity: Arc<ActivityBus>,
        home: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            helper,
            sessions: Mutex::new(Sessions::default()),
            input: InputMutex::default(),
            policy: Policy::load(server_dir),
            activity,
            stopped: AtomicBool::new(false),
            session_grants: Mutex::new(HashSet::new()),
            shots: Mutex::new(VecDeque::new()),
            home,
        })
    }

    /// Ends sessions that have sat idle past their timeout, every few seconds.
    pub fn start_sweeper(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(service) = weak.upgrade() else {
                return;
            };
            service.sweep_idle(now_ms());
        });
    }

    fn settings(&self) -> ComputerUseSettings {
        policy::load_settings(self.home.as_deref())
    }

    fn sweep_idle(&self, now: u64) {
        let idle_ms = self.settings().idle_timeout_ms.map_or(
            CONSTANTS.computer.idle_timeout_ms.get(),
            std::num::NonZero::get,
        );
        let idle = self
            .sessions
            .lock()
            .map(|s| s.idle(now, idle_ms))
            .unwrap_or_default();
        for id in idle {
            self.end_session(&id, "idle");
        }
    }

    /// Ends every session a tab owns: the tab closed, or its agent finished.
    pub fn end_tab(&self, tab_id: &str) {
        let ids = self
            .sessions
            .lock()
            .map(|s| s.of_tab(tab_id))
            .unwrap_or_default();
        for id in ids {
            self.end_session(&id, "owner finished");
        }
    }

    fn end_session(&self, id: &str, why: &str) -> Option<ComputerSession> {
        let ended = self.sessions.lock().ok()?.end(id)?;
        if let Ok(mut grants) = self.session_grants.lock() {
            grants.remove(&owner_key(&ended.owner));
        }
        let mut ended_event = event(ComputerActivityType::SessionEnded);
        ended_event.session_id = Some(ended.id.clone());
        ended_event.caller = Some(ended.owner.clone());
        ended_event.description = Some(why.to_string());
        ended_event.session = Some(ended.clone());
        self.activity.emit(ended_event);
        Some(ended)
    }

    /// The live picture, for `status` and the stream snapshot.
    pub fn snapshot(&self, host: &dyn ComputerHost) -> ComputerActivitySnapshot {
        ComputerActivitySnapshot {
            enabled: is_enabled(&self.settings()),
            desktop_connected: host.desktop_connected(),
            sessions: self.sessions.lock().map(|s| s.all()).unwrap_or_default(),
            approvals: self.policy.pending(),
            helper: self.helper.status(),
            stopped: self.stopped.load(Ordering::SeqCst),
            last_seq: self.activity.last_seq(),
        }
    }

    /// Subscribes to `computerActivity`.
    pub fn subscribe(
        &self,
        host: &dyn ComputerHost,
    ) -> (Vec<EventFrame>, std::sync::mpsc::Receiver<EventFrame>) {
        let snapshot = serde_json::to_value(self.snapshot(host)).unwrap_or_default();
        self.activity.subscribe(snapshot)
    }

    /// Dispatches one `computer` RPC.
    pub fn handle_rpc(
        &self,
        host: &dyn ComputerHost,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, ComputerFailure> {
        let request: ComputerRequest = serde_json::from_value(payload).map_err(|error| {
            failure(
                ComputerErrorCode::InvalidPayload,
                format!("invalid computer request: {error}"),
            )
        })?;
        let caller = resolve_caller(host, request.caller);
        let op = request.op.op();
        if command_spec(op).desktop_only && caller.kind != ComputerCallerKind::User {
            return Err(failure(
                ComputerErrorCode::NotAuthorized,
                "only the Pragma desktop app can do that",
            ));
        }
        match request.op {
            ComputerOpRequest::Open(request) => self.open(host, &caller, request),
            request @ (ComputerOpRequest::Apps(_)
            | ComputerOpRequest::Windows(_)
            | ComputerOpRequest::Displays
            | ComputerOpRequest::Inspect(_)
            | ComputerOpRequest::Screenshot(_)) => self.read(host, &caller, op, request),
            request @ (ComputerOpRequest::Focus(_)
            | ComputerOpRequest::Click(_)
            | ComputerOpRequest::Type(_)
            | ComputerOpRequest::Key(_)
            | ComputerOpRequest::Scroll(_)
            | ComputerOpRequest::Move(_)
            | ComputerOpRequest::Drag(_)) => {
                let action = self.plan(request)?;
                self.act(host, &caller, op, action)
            }
            request => self.control(host, &caller, request),
        }
    }

    /// The read-only operations: authorized, but needing no desktop and no lease.
    fn read(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
        request: ComputerOpRequest,
    ) -> Result<serde_json::Value, ComputerFailure> {
        self.authorize_read(host, caller, op)?;
        match request {
            ComputerOpRequest::Apps(request) => {
                let mut apps: Vec<ComputerApp> =
                    from_value(self.helper_call(HelperOp::Apps(request))?)?;
                let extra = self.settings().blocked_apps;
                for app in &mut apps {
                    app.blocked = Some(is_blocked(&identity(app), &extra));
                }
                to_value(&apps)
            }
            ComputerOpRequest::Windows(request) => self.helper_call(HelperOp::Windows(request)),
            ComputerOpRequest::Displays => self.helper_call(HelperOp::Displays),
            ComputerOpRequest::Inspect(request) => {
                let snapshot: ComputerSnapshot =
                    from_value(self.helper_call(HelperOp::Inspect(request))?)?;
                self.refuse_blocked(&snapshot.app)?;
                to_value(&snapshot)
            }
            ComputerOpRequest::Screenshot(request) => {
                if request.app.is_some() || request.pid.is_some() {
                    let resolved = self.resolve(ResolveRequest {
                        app: request.app.clone(),
                        pid: request.pid,
                        ..ResolveRequest::default()
                    })?;
                    self.refuse_blocked(&resolved.app)?;
                }
                let shot: ComputerScreenshot =
                    from_value(self.helper_call(HelperOp::Screenshot(request))?)?;
                self.remember_shot(&shot);
                to_value(&shot)
            }
            other => Err(misrouted(&other)),
        }
    }

    /// Turns a mutating request into the target, wording, and helper call the
    /// action pipeline runs.
    fn plan(&self, request: ComputerOpRequest) -> Result<Action, ComputerFailure> {
        Ok(match request {
            ComputerOpRequest::Focus(request) => {
                let target = ResolveRequest {
                    app: request.app.clone(),
                    pid: request.pid,
                    window: request.window.clone(),
                    ..ResolveRequest::default()
                };
                let description = "Bring to front".to_string();
                Action {
                    target,
                    verb: description,
                    method: None,
                    helper_op: HelperOp::Focus(request),
                }
            }
            ComputerOpRequest::Click(mut request) => {
                self.map_image_point(&mut request)?;
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    request.x,
                    request.y,
                );
                let method = request.method;
                Action {
                    target,
                    verb: "Click".to_string(),
                    method,
                    helper_op: HelperOp::Click(request),
                }
            }
            ComputerOpRequest::Type(request) => {
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    None,
                    None,
                );
                let description = format!("Type {}", redact_text(&request.text));
                let method = request.method;
                Action {
                    target,
                    verb: description,
                    method,
                    helper_op: HelperOp::Type(request),
                }
            }
            ComputerOpRequest::Key(request) => {
                let target = target_of(request.app.as_ref(), request.pid, None, None, None);
                let description = format!("Press {}", request.chords.join(" "));
                Action {
                    target,
                    verb: description,
                    method: Some(ComputerMethod::Keys),
                    helper_op: HelperOp::Key(request),
                }
            }
            other => return Self::plan_pointer(other),
        })
    }

    /// [`Self::plan`] for the operations that aim the pointer at a place.
    fn plan_pointer(request: ComputerOpRequest) -> Result<Action, ComputerFailure> {
        Ok(match request {
            ComputerOpRequest::Scroll(request) => {
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    request.x,
                    request.y,
                );
                let description = format!(
                    "Scroll {}",
                    serde_json::to_value(request.direction)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default()
                );
                Action {
                    target,
                    verb: description,
                    method: Some(ComputerMethod::Pointer),
                    helper_op: HelperOp::Scroll(request),
                }
            }
            ComputerOpRequest::Move(request) => {
                let target = target_of(
                    request.app.as_ref(),
                    request.pid,
                    request.element.as_ref(),
                    request.x,
                    request.y,
                );
                let method = if request.visual_only == Some(true) {
                    Some(ComputerMethod::Ax)
                } else {
                    Some(ComputerMethod::Pointer)
                };
                Action {
                    target,
                    verb: "Point".to_string(),
                    method,
                    helper_op: HelperOp::Move(request),
                }
            }
            ComputerOpRequest::Drag(request) => {
                let from = pragma_core::computer::parse_point(&request.from);
                let target = ResolveRequest {
                    app: request.app.clone(),
                    pid: request.pid,
                    element: from.is_none().then(|| request.from.clone()),
                    point: from,
                    ..ResolveRequest::default()
                };
                Action {
                    target,
                    verb: "Drag".to_string(),
                    method: Some(ComputerMethod::Pointer),
                    helper_op: HelperOp::Drag(request),
                }
            }
            other => return Err(misrouted(&other)),
        })
    }

    /// Status, diagnostics, and the desktop's controls.
    fn control(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerOpRequest,
    ) -> Result<serde_json::Value, ComputerFailure> {
        match request {
            ComputerOpRequest::Status => to_value(&self.snapshot(host)),
            ComputerOpRequest::Permissions(request) => {
                self.helper_call(HelperOp::Permissions(request))
            }
            ComputerOpRequest::End(request) => {
                let id = match (&request.session, caller.kind) {
                    (Some(id), ComputerCallerKind::User) => Some(id.clone()),
                    _ => self
                        .sessions
                        .lock()
                        .ok()
                        .and_then(|s| s.of(caller).map(|s| s.id.clone())),
                };
                let ended = id.and_then(|id| self.end_session(&id, "ended"));
                Ok(serde_json::json!({ "ended": ended.is_some(), "session": ended }))
            }
            // Frames are screenshots; only the desktop's PiP may pull them.
            ComputerOpRequest::Frame(request) if caller.kind == ComputerCallerKind::User => {
                self.frame(&request)
            }
            ComputerOpRequest::Frame(_) => Err(failure(
                ComputerErrorCode::NotAuthorized,
                "only the Pragma desktop app can read session frames",
            )),
            ComputerOpRequest::Approve(request) => {
                let approval = self.policy.answer(&request.approval, request.decision)?;
                let mut resolved = event(ComputerActivityType::ApprovalResolved);
                resolved.caller = Some(approval.caller.clone());
                resolved.approval = Some(approval);
                resolved.description = serde_json::to_value(request.decision)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string));
                self.activity.emit(resolved);
                Ok(serde_json::Value::Null)
            }
            ComputerOpRequest::Pause(request) => {
                self.set_paused(request.session.as_deref(), Some(ComputerPauseReason::User));
                Ok(serde_json::Value::Null)
            }
            ComputerOpRequest::Unpause(request) => {
                if self.stopped.swap(false, Ordering::SeqCst) {
                    self.helper.set_stopped(false);
                }
                self.set_paused(request.session.as_deref(), None);
                Ok(serde_json::Value::Null)
            }
            ComputerOpRequest::Stop(request) => {
                // With a session, Stop ends that one (the PiP's Stop button);
                // without, it is the emergency stop for everything.
                match request.session {
                    Some(id) => {
                        self.end_session(&id, "stopped");
                    }
                    None => self.stop(),
                }
                Ok(serde_json::Value::Null)
            }
            other => Err(misrouted(&other)),
        }
    }

    /// The emergency stop: latch, deny every prompt, end every session.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.helper.set_stopped(true);
        self.policy.deny_all();
        let ended = self
            .sessions
            .lock()
            .map(|mut s| s.end_all())
            .unwrap_or_default();
        if let Ok(mut grants) = self.session_grants.lock() {
            grants.clear();
        }
        for session in ended {
            let mut ended_event = event(ComputerActivityType::SessionEnded);
            ended_event.session_id = Some(session.id.clone());
            ended_event.caller = Some(session.owner.clone());
            ended_event.description = Some("stopped".to_string());
            ended_event.session = Some(session);
            self.activity.emit(ended_event);
        }
        self.activity.emit(event(ComputerActivityType::Stopped));
    }

    fn set_paused(&self, session: Option<&str>, reason: Option<ComputerPauseReason>) {
        let changed = self
            .sessions
            .lock()
            .map(|mut s| s.set_paused(session, reason))
            .unwrap_or_default();
        for session in changed {
            let kind = if reason.is_some() {
                ComputerActivityType::SessionPaused
            } else {
                ComputerActivityType::SessionResumed
            };
            let mut paused = event(kind);
            paused.session_id = Some(session.id.clone());
            paused.caller = Some(session.owner.clone());
            paused.session = Some(session);
            self.activity.emit(paused);
        }
    }

    fn helper_call(&self, op: HelperOp) -> Result<serde_json::Value, ComputerFailure> {
        let timeout = timeout_for(&op);
        self.helper.call(op, timeout)
    }

    fn resolve(&self, request: ResolveRequest) -> Result<Resolved, ComputerFailure> {
        from_value(self.helper_call(HelperOp::Resolve(request))?)
    }

    fn refuse_blocked(&self, app: &ComputerApp) -> Result<(), ComputerFailure> {
        if is_blocked(&identity(app), &self.settings().blocked_apps) {
            let mut blocked = failure(
                ComputerErrorCode::BlockedApp,
                format!("{} cannot be controlled or read by agents", app.name),
            );
            blocked.hint = Some("Pragma itself, password managers, and system security prompts are always off limits.".to_string());
            return Err(blocked);
        }
        Ok(())
    }

    fn remember_shot(&self, shot: &ComputerScreenshot) {
        if let Ok(mut shots) = self.shots.lock() {
            if shots.len() >= SHOT_MEMORY {
                shots.pop_front();
            }
            shots.push_back((shot.id.clone(), shot.origin.clone(), shot.scale));
        }
    }

    /// Turns `imageX`/`imageY` on a screenshot into screen coordinates, so a
    /// caller doing vision on a screenshot never maps pixels itself.
    fn map_image_point(&self, request: &mut ComputerClickRequest) -> Result<(), ComputerFailure> {
        let (Some(image_x), Some(image_y)) = (request.image_x, request.image_y) else {
            return Ok(());
        };
        let id = request.screenshot.as_deref().ok_or_else(|| {
            failure(
                ComputerErrorCode::InvalidPayload,
                "imageX/imageY need --screenshot <id>",
            )
        })?;
        let (origin, scale) = self
            .shots
            .lock()
            .ok()
            .and_then(|shots| {
                shots
                    .iter()
                    .find(|(shot, _, _)| shot == id)
                    .map(|(_, origin, scale)| (origin.clone(), *scale))
            })
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::SnapshotExpired,
                    format!("screenshot `{id}` is not known; take a new one"),
                )
            })?;
        let point = image_to_screen(&origin, scale, image_x, image_y);
        request.x = Some(point.x);
        request.y = Some(point.y);
        request.image_x = None;
        request.image_y = None;
        request.screenshot = None;
        Ok(())
    }

    // -------------------------------------------------------------- policy

    fn require_enabled(&self) -> Result<ComputerUseSettings, ComputerFailure> {
        let settings = self.settings();
        if is_enabled(&settings) {
            return Ok(settings);
        }
        let mut disabled = failure(ComputerErrorCode::Disabled, "computer use is turned off");
        disabled.hint = Some("Turn it on in Pragma under Settings → Computer Use.".to_string());
        Err(disabled)
    }

    fn authorize_read(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
    ) -> Result<(), ComputerFailure> {
        let settings = self.require_enabled()?;
        self.authorize(host, &settings, caller, op, None, None)
    }

    /// Checks the caller against the policy, asking the desktop user when it
    /// says `ask` and no grant covers this owner yet.
    fn authorize(
        &self,
        host: &dyn ComputerHost,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
        op: ComputerOp,
        session_id: Option<&str>,
        target: Option<&ComputerTarget>,
    ) -> Result<(), ComputerFailure> {
        if caller.kind == ComputerCallerKind::User {
            return Ok(());
        }
        match self.policy.access(settings, caller) {
            ComputerAccess::Allow => Ok(()),
            ComputerAccess::Deny => Err(failure(
                ComputerErrorCode::NotAuthorized,
                format!(
                    "{} is not allowed to use the computer",
                    caller_label(caller)
                ),
            )),
            ComputerAccess::Ask => {
                let key = owner_key(caller);
                if self
                    .session_grants
                    .lock()
                    .is_ok_and(|grants| grants.contains(&key))
                {
                    return Ok(());
                }
                let reason = format!("{} wants to use your computer", caller_label(caller));
                let approval = approval_for(caller, op, session_id, target, reason, false);
                match self.ask(host, &approval)? {
                    Verdict::Allowed {
                        remember_for_session,
                    } => {
                        if remember_for_session {
                            if let Ok(mut grants) = self.session_grants.lock() {
                                grants.insert(key);
                            }
                        }
                        Ok(())
                    }
                    Verdict::Denied => Err(failure(ComputerErrorCode::Denied, "the user declined")),
                }
            }
        }
    }

    /// Asks the desktop user, blocking until they answer.
    fn ask(
        &self,
        host: &dyn ComputerHost,
        approval: &ComputerApproval,
    ) -> Result<Verdict, ComputerFailure> {
        if !host.desktop_connected() {
            let mut offline = failure(
                ComputerErrorCode::NotAuthorized,
                "computer use needs approval in Pragma, which is not running",
            );
            offline.hint = Some(
                "Open Pragma and try again, or allow this agent under Settings → Computer Use."
                    .to_string(),
            );
            return Err(offline);
        }
        let activity = Arc::clone(&self.activity);
        self.policy.wait_for(approval, |approval| {
            let mut requested = event(ComputerActivityType::ApprovalRequested);
            requested.caller = Some(approval.caller.clone());
            requested.session_id.clone_from(&approval.session_id);
            requested.op = Some(approval.op);
            requested.target.clone_from(&approval.target);
            requested.approval = Some(approval.clone());
            activity.emit(requested);
        })
    }

    // -------------------------------------------------------------- actions

    fn preflight(&self, host: &dyn ComputerHost) -> Result<ComputerUseSettings, ComputerFailure> {
        if self.stopped.load(Ordering::SeqCst) {
            let mut stopped = failure(
                ComputerErrorCode::Stopped,
                "computer use was stopped by the user",
            );
            stopped.hint = Some("The user can resume it from the Pragma sidebar.".to_string());
            return Err(stopped);
        }
        let settings = self.require_enabled()?;
        if !host.desktop_connected() {
            let mut offline = failure(
                ComputerErrorCode::IndicatorUnavailable,
                "controlling apps needs the Pragma desktop app open, so the user can see and stop it",
            );
            offline.hint = Some("Open Pragma, then retry.".to_string());
            return Err(offline);
        }
        Ok(settings)
    }

    /// Refuses to act while the user is physically using the machine.
    fn refuse_if_user_active(&self) -> Result<(), ComputerFailure> {
        let seconds = self
            .helper_call(HelperOp::Idle)
            .ok()
            .and_then(|value| value.get("seconds").and_then(serde_json::Value::as_f64));
        if seconds.is_some_and(|seconds| seconds < TAKEOVER_WINDOW_SECONDS) {
            return Err(failure(
                ComputerErrorCode::UserTakeover,
                "the user is using the keyboard or pointer right now",
            ));
        }
        Ok(())
    }

    fn open(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        request: ComputerOpenRequest,
    ) -> Result<serde_json::Value, ComputerFailure> {
        let settings = self.preflight(host)?;
        let name = request.app.clone().unwrap_or_default();
        // Refuse a blocked app by name before launching it, and again by the
        // identity it actually launched as.
        let named = AppIdentity {
            bundle_id: request.app.as_deref(),
            path: request.app.as_deref(),
            name: &name,
        };
        if is_blocked(&named, &settings.blocked_apps) {
            return Err(failure(
                ComputerErrorCode::BlockedApp,
                format!("{name} cannot be controlled by agents"),
            ));
        }
        let target = ComputerTarget {
            app_id: None,
            app_name: Some(name.clone()),
            window_id: None,
            element_id: None,
            element_label: None,
            role: None,
        };
        let session = self.begin(host, &settings, caller, ComputerOp::Open, &target)?;
        let action_id = self.announce(
            &session,
            ComputerOp::Open,
            &target,
            None,
            format!("Open {name}"),
        );
        let started = std::time::Instant::now();
        let result: Result<Focused, ComputerFailure> = self
            .helper_call(HelperOp::Open(request))
            .and_then(from_value);
        let focused = match result {
            Ok(focused) => focused,
            Err(error) => {
                return Err(self.failed(&session, caller, ComputerOp::Open, &action_id, error))
            }
        };
        if let Err(error) = self.refuse_blocked(&focused.app) {
            return Err(self.failed(&session, caller, ComputerOp::Open, &action_id, error));
        }
        if let Err(error) = self.take_lease(&session, &focused.app) {
            return Err(self.failed(&session, caller, ComputerOp::Open, &action_id, error));
        }
        let performed = Performed {
            method: ComputerMethod::Ax,
            physical_cursor: false,
            element: None,
        };
        let result = self.completed(
            &session,
            caller,
            ComputerOp::Open,
            &action_id,
            &target,
            &performed,
            started,
            format!("Open {}", focused.app.name),
        );
        let mut value = to_value(&result)?;
        value["app"] = to_value(&focused.app)?;
        if let Some(window) = &focused.window {
            value["window"] = to_value(window)?;
        }
        Ok(value)
    }

    /// The mutating-action pipeline shared by every operation but `open`.
    fn act(
        &self,
        host: &dyn ComputerHost,
        caller: &ComputerCaller,
        op: ComputerOp,
        action: Action,
    ) -> Result<serde_json::Value, ComputerFailure> {
        let Action {
            target,
            verb,
            method,
            helper_op,
        } = action;
        let settings = self.preflight(host)?;
        let resolved = self.resolve(target)?;
        self.refuse_blocked(&resolved.app)?;
        let label = resolved
            .element
            .as_ref()
            .map(|element| truncate_label(&element.label));
        let activity_target = ComputerTarget {
            app_id: Some(resolved.app.id.clone()),
            app_name: Some(resolved.app.name.clone()),
            window_id: resolved.window.as_ref().map(|window| window.id.clone()),
            element_id: resolved.element.as_ref().map(|element| element.id.clone()),
            element_label: label.clone(),
            role: resolved
                .element
                .as_ref()
                .map(|element| element.role.clone()),
        };
        let session = self.begin(host, &settings, caller, op, &activity_target)?;
        self.approve_sensitive(
            host,
            &settings,
            caller,
            op,
            &session,
            &resolved,
            &activity_target,
        )?;
        self.take_lease(&session, &resolved.app)?;
        let spec = command_spec(op);
        let needs_input = match spec.input_lock {
            ComputerInputLock::None => false,
            ComputerInputLock::Always => true,
            ComputerInputLock::Pointer => method != Some(ComputerMethod::Ax),
        };
        let _input = if needs_input {
            self.refuse_if_user_active()?;
            Some(self.input.take()?)
        } else {
            None
        };
        let description = match &label {
            Some(label) if !label.is_empty() => format!("{verb} “{label}”"),
            _ => format!("{verb} in {}", resolved.app.name),
        };
        let action_id = self.announce(
            &session,
            op,
            &activity_target,
            resolved.point.clone(),
            description.clone(),
        );
        if resolved.point.is_some() {
            // Let the overlay cursor arrive before anything moves.
            std::thread::sleep(Duration::from_millis(CONSTANTS.computer.cursor_lead_ms));
        }
        let started = std::time::Instant::now();
        let outcome: Result<Performed, ComputerFailure> =
            self.helper_call(helper_op).and_then(from_value);
        match outcome {
            Ok(performed) => {
                let result = self.completed(
                    &session,
                    caller,
                    op,
                    &action_id,
                    &activity_target,
                    &performed,
                    started,
                    description,
                );
                to_value(&result)
            }
            Err(error) => Err(self.failed(&session, caller, op, &action_id, error)),
        }
    }

    /// Authorizes the caller and opens (or reuses) its session.
    fn begin(
        &self,
        host: &dyn ComputerHost,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
        op: ComputerOp,
        target: &ComputerTarget,
    ) -> Result<ComputerSession, ComputerFailure> {
        let existing = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.of(caller).cloned());
        self.authorize(
            host,
            settings,
            caller,
            op,
            existing.as_ref().map(|s| s.id.as_str()),
            Some(target),
        )?;
        let (session, new) = self
            .sessions
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "session lock poisoned"))?
            .open(caller, now_ms());
        if new {
            let mut started = event(ComputerActivityType::SessionStarted);
            started.session_id = Some(session.id.clone());
            started.caller = Some(session.owner.clone());
            started.session = Some(session.clone());
            self.activity.emit(started);
        }
        if session.paused {
            return Err(failure(
                ComputerErrorCode::UserTakeover,
                "the user paused this session from Pragma",
            ));
        }
        Ok(session)
    }

    #[allow(clippy::too_many_arguments)]
    fn approve_sensitive(
        &self,
        host: &dyn ComputerHost,
        settings: &ComputerUseSettings,
        caller: &ComputerCaller,
        op: ComputerOp,
        session: &ComputerSession,
        resolved: &Resolved,
        target: &ComputerTarget,
    ) -> Result<(), ComputerFailure> {
        if caller.kind == ComputerCallerKind::User {
            return Ok(());
        }
        let sensitive = settings
            .access
            .as_ref()
            .and_then(|access| access.sensitive)
            .unwrap_or(ComputerAccess::Ask);
        if sensitive == ComputerAccess::Allow {
            return Ok(());
        }
        let Some(element) = &resolved.element else {
            return Ok(());
        };
        let reason = if op == ComputerOp::Click && is_sensitive_label(&element.label) {
            format!(
                "{} wants to click “{}” in {}",
                caller_label(caller),
                truncate_label(&element.label),
                resolved.app.name
            )
        } else if op == ComputerOp::Type && element.secure {
            format!(
                "{} wants to type into a password field in {}",
                caller_label(caller),
                resolved.app.name
            )
        } else {
            return Ok(());
        };
        if sensitive == ComputerAccess::Deny {
            return Err(failure(ComputerErrorCode::NotAuthorized, reason));
        }
        let approval = approval_for(caller, op, Some(&session.id), Some(target), reason, true);
        match self.ask(host, &approval)? {
            Verdict::Allowed { .. } => Ok(()),
            Verdict::Denied => Err(failure(ComputerErrorCode::Denied, "the user declined")),
        }
    }

    fn take_lease(
        &self,
        session: &ComputerSession,
        app: &ComputerApp,
    ) -> Result<(), ComputerFailure> {
        let identifier = app
            .bundle_id
            .as_deref()
            .or(app.path.as_deref())
            .unwrap_or(&app.name);
        let key = app_key(identifier);
        let result = self
            .sessions
            .lock()
            .map_err(|_| failure(ComputerErrorCode::Internal, "session lock poisoned"))?
            .lease(&session.id, &key, &app.name, app.pid, now_ms());
        if let Err(error) = &result {
            let mut denied = event(ComputerActivityType::LeaseDenied);
            denied.session_id = Some(session.id.clone());
            denied.caller = Some(session.owner.clone());
            denied.error = Some(error.clone());
            self.activity.emit(denied);
        }
        result.map(|_| ())
    }

    fn announce(
        &self,
        session: &ComputerSession,
        op: ComputerOp,
        target: &ComputerTarget,
        point: Option<ComputerPoint>,
        description: String,
    ) -> String {
        let action_id = format!("ca_{}", uuid::Uuid::new_v4().simple());
        let mut started = event(ComputerActivityType::ActionStarted);
        started.session_id = Some(session.id.clone());
        started.action_id = Some(action_id.clone());
        started.caller = Some(session.owner.clone());
        started.op = Some(op);
        started.target = Some(target.clone());
        started.pointer = point.map(|to| ComputerPointer {
            from: None,
            to,
            display_id: None,
            lead_ms: CONSTANTS.computer.cursor_lead_ms,
        });
        started.description = Some(description);
        self.activity.emit(started);
        action_id
    }

    #[allow(clippy::too_many_arguments)]
    fn completed(
        &self,
        session: &ComputerSession,
        caller: &ComputerCaller,
        op: ComputerOp,
        action_id: &str,
        target: &ComputerTarget,
        performed: &Performed,
        started: std::time::Instant,
        description: String,
    ) -> ComputerActionResult {
        let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let touched = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut s| s.touch(&session.id, now_ms(), Some(description.clone())));
        let mut done = event(ComputerActivityType::ActionCompleted);
        done.session_id = Some(session.id.clone());
        done.action_id = Some(action_id.to_string());
        done.caller = Some(caller.clone());
        done.op = Some(op);
        done.target = Some(target.clone());
        done.method = Some(performed.method);
        done.physical_cursor = Some(performed.physical_cursor);
        done.description = Some(description);
        done.session = touched;
        self.activity.emit(done);
        ComputerActionResult {
            session_id: session.id.clone(),
            action_id: action_id.to_string(),
            method: performed.method,
            physical_cursor: performed.physical_cursor,
            elapsed_ms: elapsed,
            app: None,
            window: None,
            element: performed.element.clone(),
        }
    }

    fn failed(
        &self,
        session: &ComputerSession,
        caller: &ComputerCaller,
        op: ComputerOp,
        action_id: &str,
        error: ComputerFailure,
    ) -> ComputerFailure {
        let mut failed = event(ComputerActivityType::ActionFailed);
        failed.session_id = Some(session.id.clone());
        failed.action_id = Some(action_id.to_string());
        failed.caller = Some(caller.clone());
        failed.op = Some(op);
        failed.error = Some(error.clone());
        self.activity.emit(failed);
        error
    }

    /// A small JPEG of a session's controlled app, for the desktop's
    /// picture-in-picture window.
    fn frame(&self, request: &ComputerFrameRequest) -> Result<serde_json::Value, ComputerFailure> {
        let lease = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| {
                s.by_id(&request.session)
                    .and_then(|session| session.leases.last().cloned())
            })
            .ok_or_else(|| {
                failure(
                    ComputerErrorCode::WindowNotFound,
                    "that session is not controlling an app",
                )
            })?;
        let shot =
            ComputerScreenshotRequest {
                app: if lease.pid.is_some() {
                    None
                } else {
                    Some(lease.app_key.clone())
                },
                pid: lease.pid,
                window: None,
                display: None,
                region: None,
                out: None,
                format: Some(ComputerImageFormat::Jpeg),
                max_width: Some(request.max_width.unwrap_or(
                    std::num::NonZero::new(480).unwrap_or(std::num::NonZero::<u64>::MIN),
                )),
                base64: Some(true),
            };
        let shot: ComputerScreenshot = from_value(self.helper_call(HelperOp::Screenshot(shot))?)?;
        // The PiP holds the bytes; the file is not needed once read.
        let _ = std::fs::remove_file(&shot.path);
        to_value(&shot)
    }
}

/// A new approval prompt, expiring after the shipped timeout.
fn approval_for(
    caller: &ComputerCaller,
    op: ComputerOp,
    session_id: Option<&str>,
    target: Option<&ComputerTarget>,
    reason: String,
    sensitive: bool,
) -> ComputerApproval {
    let now = now_ms();
    ComputerApproval {
        id: format!("ap_{}", uuid::Uuid::new_v4().simple()),
        caller: caller.clone(),
        session_id: session_id.map(str::to_string),
        op,
        reason,
        sensitive,
        target: target.cloned(),
        requested_at: now,
        expires_at: now + CONSTANTS.computer.approval_timeout_ms.get(),
    }
}

/// Fills in what the host knows about a caller, defaulting to `sdk`.
fn resolve_caller(host: &dyn ComputerHost, caller: Option<ComputerCaller>) -> ComputerCaller {
    let mut caller = caller.unwrap_or(ComputerCaller {
        kind: ComputerCallerKind::Sdk,
        tab_id: None,
        worktree_id: None,
        agent_id: None,
        plugin_id: None,
        label: None,
    });
    if caller.kind == ComputerCallerKind::AgentTab && caller.agent_id.is_none() {
        caller.agent_id = caller
            .tab_id
            .as_deref()
            .and_then(|tab| host.agent_for_tab(tab));
    }
    caller
}

fn identity(app: &ComputerApp) -> AppIdentity<'_> {
    AppIdentity {
        bundle_id: app.bundle_id.as_deref(),
        path: app.path.as_deref(),
        name: &app.name,
    }
}

fn target_of(
    app: Option<&String>,
    pid: Option<u64>,
    element: Option<&String>,
    x: Option<f64>,
    y: Option<f64>,
) -> ResolveRequest {
    ResolveRequest {
        app: app.cloned(),
        pid,
        window: None,
        element: element.cloned(),
        point: match (x, y) {
            (Some(x), Some(y)) => Some(ComputerPoint { x, y }),
            _ => None,
        },
    }
}

/// The time a helper call may take.
fn timeout_for(op: &HelperOp) -> Duration {
    let action = Duration::from_millis(CONSTANTS.computer.action_timeout_ms.get());
    match op {
        HelperOp::Open(request) => {
            Duration::from_millis(
                request
                    .wait_ready_ms
                    .unwrap_or(CONSTANTS.computer.app_launch_wait_ms.get()),
            ) + action
        }
        // Long text types in chunks; give it time proportional to its length.
        HelperOp::Type(request) => {
            action + Duration::from_millis(u64::try_from(request.text.len()).unwrap_or(0) * 2)
        }
        HelperOp::Drag(request) => action + Duration::from_millis(request.duration_ms.unwrap_or(0)),
        _ => action,
    }
    .saturating_add(CALL_SLACK)
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, ComputerFailure> {
    serde_json::to_value(value)
        .map_err(|error| failure(ComputerErrorCode::Internal, error.to_string()))
}

fn from_value<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
) -> Result<T, ComputerFailure> {
    serde_json::from_value(value).map_err(|error| {
        failure(
            ComputerErrorCode::Internal,
            format!("unexpected helper reply: {error}"),
        )
    })
}

impl ComputerHost for crate::registry::Registry {
    fn desktop_connected(&self) -> bool {
        self.controller_writer().ok().flatten().is_some()
    }

    fn agent_for_tab(&self, tab_id: &str) -> Option<String> {
        crate::registry::Registry::agent_for_tab(self, tab_id)
    }
}

#[cfg(test)]
mod tests;
