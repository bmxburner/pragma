//! The backend for platforms computer use does not support yet.
//!
//! Every call fails with `unsupportedPlatform`, never an empty result: an
//! empty app list would read as "nothing is running" rather than "this cannot
//! work here". Windows support lands as its own backend (UI Automation,
//! `SendInput`, Windows Graphics Capture); Linux is out of scope.

#![cfg_attr(target_os = "macos", allow(dead_code))]

use pragma_constants::{
    ComputerApp, ComputerAppsRequest, ComputerClickRequest, ComputerDisplay, ComputerDragRequest,
    ComputerErrorCode, ComputerFailure, ComputerFocusRequest, ComputerInspectRequest,
    ComputerKeyRequest, ComputerMoveRequest, ComputerOpenRequest, ComputerPermissionState,
    ComputerPermissions, ComputerScreenshot, ComputerScreenshotRequest, ComputerScrollRequest,
    ComputerSnapshot, ComputerTypeRequest, ComputerWindow, ComputerWindowsRequest,
};

use crate::{
    failure, platform_name, ComputerBackend, ComputerResult, Context, Focused, Performed,
    ResolveRequest, Resolved,
};

/// Refuses every operation with `unsupportedPlatform`.
pub struct UnsupportedBackend;

fn unsupported() -> ComputerFailure {
    failure(
        ComputerErrorCode::UnsupportedPlatform,
        format!("computer use is not supported on {} yet", platform_name()),
    )
}

impl ComputerBackend for UnsupportedBackend {
    fn permissions(&mut self, _request: bool) -> ComputerResult<ComputerPermissions> {
        Ok(ComputerPermissions {
            platform: platform_name().to_string(),
            supported: false,
            accessibility: ComputerPermissionState::NotApplicable,
            screen_recording: ComputerPermissionState::NotApplicable,
        })
    }
    fn displays(&mut self) -> ComputerResult<Vec<ComputerDisplay>> {
        Err(unsupported())
    }
    fn apps(&mut self, _: &ComputerAppsRequest) -> ComputerResult<Vec<ComputerApp>> {
        Err(unsupported())
    }
    fn windows(&mut self, _: &ComputerWindowsRequest) -> ComputerResult<Vec<ComputerWindow>> {
        Err(unsupported())
    }
    fn open(&mut self, _: &Context, _: &ComputerOpenRequest) -> ComputerResult<Focused> {
        Err(unsupported())
    }
    fn focus(&mut self, _: &Context, _: &ComputerFocusRequest) -> ComputerResult<Focused> {
        Err(unsupported())
    }
    fn inspect(&mut self, _: &ComputerInspectRequest) -> ComputerResult<ComputerSnapshot> {
        Err(unsupported())
    }
    fn screenshot(
        &mut self,
        _: &Context,
        _: &ComputerScreenshotRequest,
    ) -> ComputerResult<ComputerScreenshot> {
        Err(unsupported())
    }
    fn resolve(&mut self, _: &ResolveRequest) -> ComputerResult<Resolved> {
        Err(unsupported())
    }
    fn click(&mut self, _: &Context, _: &ComputerClickRequest) -> ComputerResult<Performed> {
        Err(unsupported())
    }
    fn type_text(&mut self, _: &Context, _: &ComputerTypeRequest) -> ComputerResult<Performed> {
        Err(unsupported())
    }
    fn key(&mut self, _: &Context, _: &ComputerKeyRequest) -> ComputerResult<Performed> {
        Err(unsupported())
    }
    fn scroll(&mut self, _: &Context, _: &ComputerScrollRequest) -> ComputerResult<Performed> {
        Err(unsupported())
    }
    fn move_pointer(&mut self, _: &Context, _: &ComputerMoveRequest) -> ComputerResult<Performed> {
        Err(unsupported())
    }
    fn drag(&mut self, _: &Context, _: &ComputerDragRequest) -> ComputerResult<Performed> {
        Err(unsupported())
    }
    fn seconds_since_user_input(&mut self) -> Option<f64> {
        None
    }
}
