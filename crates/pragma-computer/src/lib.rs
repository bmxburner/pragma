//! Native computer use for Pragma: accessibility snapshots, screen capture,
//! and synthetic input, behind one [`ComputerBackend`] trait.
//!
//! This crate runs inside the `pragma-computer` helper process, never inside
//! `pragma-server` or the desktop app. A hung accessibility call or a crash in
//! native code then costs one in-flight action, not every terminal session, and
//! the helper has a stable identity for the OS permission prompts. The server
//! supervises the helper and speaks [`protocol`] to it over the helper's
//! standard streams; sessions, leases, policy, and the activity stream are the
//! server's, and none of them live here.
//!
//! Platform code sits in `macos/` (Accessibility, `CGEvent`, `NSWorkspace`);
//! window listing, displays, and capture go through `xcap` on every platform
//! (`capture.rs`). A platform without a backend answers every call with an
//! explicit `unsupportedPlatform` failure, never an empty result.

// Every fallible call here returns the shared `ComputerFailure` wire type,
// whose message, hint, and details map make it larger than clippy's 128-byte
// threshold. Failures are the cold path and are serialized to JSON at once;
// boxing each one would cost every call site a conversion for no gain.
#![allow(clippy::result_large_err)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerElement, ComputerErrorCode, ComputerFailure, ComputerFocusRequest,
    ComputerInspectRequest, ComputerKeyRequest, ComputerMethod, ComputerMoveRequest,
    ComputerOpenRequest, ComputerPermissions, ComputerPoint, ComputerScreenshot,
    ComputerScreenshotRequest, ComputerScrollRequest, ComputerSnapshot, ComputerTypeRequest,
    ComputerWindow, ComputerWindowsRequest,
};
use serde::{Deserialize, Serialize};

#[cfg(feature = "native")]
pub mod capture;
pub mod fake;
#[cfg(all(feature = "native", target_os = "macos"))]
mod macos;
pub mod protocol;
pub mod serve;
pub mod snapshot;
mod unsupported;

pub use pragma_core::computer::failure;

/// Result type for every backend call.
pub type ComputerResult<T> = Result<T, ComputerFailure>;

/// The emergency-stop latch, checked between every synthetic event.
///
/// Shared between the request reader and the worker that performs actions, so
/// a `stop` line takes effect mid-`type` without waiting for the action to end.
#[derive(Debug, Clone, Default)]
pub struct StopFlag(Arc<AtomicBool>);

impl StopFlag {
    /// Latches the stop.
    pub fn trip(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Clears the latch so actions may run again.
    pub fn clear(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    /// True while the stop is latched.
    #[must_use]
    pub fn is_tripped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// Fails with `stopped` when the latch is set. Call between events.
    pub fn check(&self) -> ComputerResult<()> {
        if self.is_tripped() {
            Err(failure(
                ComputerErrorCode::Stopped,
                "computer use was stopped by the user",
            ))
        } else {
            Ok(())
        }
    }
}

/// What every backend call can see besides its request.
#[derive(Debug, Clone)]
pub struct Context {
    /// The emergency-stop latch.
    pub stop: StopFlag,
    /// Owner-only directory screenshots are written to by default.
    pub screenshots_dir: PathBuf,
}

/// The app (and window) an `open` or `focus` ended on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Focused {
    pub app: ComputerApp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<ComputerWindow>,
}

/// A request to resolve what an action would touch, before it runs.
///
/// The server resolves first so it can take the right app lease, check the
/// policy against the real target, and show the overlay cursor at the right
/// place before anything moves.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<ComputerPoint>,
}

/// What an action would touch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub app: ComputerApp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<ComputerWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ComputerElement>,
    /// Where the pointer would go, when the action has a point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<ComputerPoint>,
}

/// How an action was performed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Performed {
    pub method: ComputerMethod,
    pub physical_cursor: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<ComputerElement>,
}

/// One platform's computer-use implementation.
///
/// Calls arrive one at a time on the helper's main thread, so platform
/// handles need not be `Send`. Every method that
/// posts more than one synthetic event checks [`Context::stop`] between them.
pub trait ComputerBackend {
    /// OS grants for this process, optionally showing the OS prompt.
    fn permissions(&mut self, request: bool) -> ComputerResult<ComputerPermissions>;
    /// Attached displays.
    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>>;
    /// Running apps, or installed ones.
    fn apps(&mut self, request: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>>;
    /// Top-level windows, optionally of one app.
    fn windows(&mut self, request: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>>;
    /// Launches or re-activates an app.
    fn open(&mut self, ctx: &Context, request: &ComputerOpenRequest) -> ComputerResult<Focused>;
    /// Activates an app or a window.
    fn focus(&mut self, ctx: &Context, request: &ComputerFocusRequest) -> ComputerResult<Focused>;
    /// An accessibility snapshot.
    fn inspect(&mut self, request: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot>;
    /// A capture, written to a file.
    fn screenshot(
        &mut self,
        ctx: &Context,
        request: &ComputerScreenshotRequest,
    ) -> ComputerResult<ComputerScreenshot>;
    /// What an action would touch.
    fn resolve(&mut self, request: &ResolveRequest) -> ComputerResult<Resolved>;
    /// Clicks an element or a point.
    fn click(&mut self, ctx: &Context, request: &ComputerClickRequest)
        -> ComputerResult<Performed>;
    /// Types caller-supplied text.
    fn type_text(
        &mut self,
        ctx: &Context,
        request: &ComputerTypeRequest,
    ) -> ComputerResult<Performed>;
    /// Presses chords.
    fn key(&mut self, ctx: &Context, request: &ComputerKeyRequest) -> ComputerResult<Performed>;
    /// Scrolls.
    fn scroll(
        &mut self,
        ctx: &Context,
        request: &ComputerScrollRequest,
    ) -> ComputerResult<Performed>;
    /// Moves the pointer.
    fn move_pointer(
        &mut self,
        ctx: &Context,
        request: &ComputerMoveRequest,
    ) -> ComputerResult<Performed>;
    /// Drags between two points or elements.
    fn drag(&mut self, ctx: &Context, request: &ComputerDragRequest) -> ComputerResult<Performed>;
    /// Seconds since the last physical (not synthetic) user input, for takeover
    /// detection. `None` when the platform cannot tell.
    fn seconds_since_user_input(&mut self) -> Option<f64>;
}

/// Re-runs the helper as its own macOS TCC identity (see `macos/responsible.rs`).
///
/// Returns the exit code to exit with when this process only waited on the
/// re-run, or `None` when it should serve. Always `None` off macOS.
#[cfg(feature = "native")]
#[must_use]
pub fn run_as_own_identity() -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        macos::run_as_own_identity()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The backend for the platform this binary was built for.
#[cfg(feature = "native")]
#[must_use]
pub fn native_backend() -> Box<dyn ComputerBackend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacBackend::new())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(unsupported::UnsupportedBackend)
    }
}

/// The platform name reported in [`ComputerPermissions::platform`].
#[must_use]
pub fn platform_name() -> &'static str {
    std::env::consts::OS
}
