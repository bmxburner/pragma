//! The only `unsafe` in the macOS backend: thin, safe wrappers over the
//! Accessibility (`AXUIElement`) C API and the one `CGEvent` call that takes a
//! raw buffer.
//!
//! This is the second documented exception to the workspace's `unsafe_code`
//! deny (the first is `pragma-platform`'s `dock` seam), approved for the
//! computer-use FFI modules. The bindings mark every AX call `unsafe` because
//! they take out-pointers; each block below states why its pointer is valid.
//! Everything above this module is safe code.

#![allow(unsafe_code)]

use std::ptr::NonNull;

use objc2_application_services::{
    AXError, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType, CGPoint, CGSize,
};
use objc2_core_graphics::CGEvent;

/// A retained accessibility element.
pub type Element = CFRetained<AXUIElement>;

/// The application element for `pid`.
pub fn application(pid: i32) -> Element {
    // SAFETY: `AXUIElementCreateApplication` accepts any pid; for a pid with
    // no process it returns an element whose calls fail with an error code.
    unsafe { AXUIElement::new_application(pid) }
}

/// The system-wide element, used for hit-testing and the focused element.
pub fn system_wide() -> Element {
    // SAFETY: takes no arguments and always returns a valid element.
    unsafe { AXUIElement::new_system_wide() }
}

/// Bounds every message to `element`'s app, so a hung app cannot hang us.
pub fn set_timeout(element: &AXUIElement, seconds: f32) {
    // SAFETY: plain value argument on a valid element.
    let _ = unsafe { element.set_messaging_timeout(seconds) };
}

/// Copies one attribute's value.
pub fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let name = CFString::from_str(name);
    let mut value: *const CFType = std::ptr::null();
    // SAFETY: `value` is a live local the call writes a +1 (Copy-rule)
    // reference into on success; it is not read unless the call succeeded.
    let error = unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) };
    if error != AXError::Success {
        return None;
    }
    let value = NonNull::new(value.cast_mut())?;
    // SAFETY: on success the reference is owned by us (Copy rule), so
    // `from_raw` takes over exactly that one retain.
    Some(unsafe { CFRetained::from_raw(value) })
}

/// A string attribute.
pub fn string(element: &AXUIElement, name: &str) -> Option<String> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFString>().map(ToString::to_string)
}

/// A boolean attribute.
pub fn boolean(element: &AXUIElement, name: &str) -> Option<bool> {
    let value = attribute(element, name)?;
    value.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool)
}

/// An element-valued attribute (`AXFocusedWindow`, `AXFocusedUIElement`).
pub fn element(element: &AXUIElement, name: &str) -> Option<Element> {
    attribute(element, name)?.downcast::<AXUIElement>().ok()
}

/// An array-of-elements attribute (`AXChildren`, `AXWindows`).
pub fn elements(element: &AXUIElement, name: &str) -> Vec<Element> {
    let Some(value) = attribute(element, name) else {
        return Vec::new();
    };
    let Ok(array) = value.downcast::<CFArray>() else {
        return Vec::new();
    };
    // SAFETY: a `CFArray` always holds CF objects; viewing its items as
    // `CFType` claims nothing more, and each is downcast before use.
    let array: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(array) };
    (0..array.len())
        .filter_map(|index| array.get(index))
        .filter_map(|item| item.downcast::<AXUIElement>().ok())
        .collect()
}

fn ax_value<T: Default>(element: &AXUIElement, name: &str, kind: AXValueType) -> Option<T> {
    let value = attribute(element, name)?;
    let value = value.downcast_ref::<AXValue>()?;
    let mut out = T::default();
    // SAFETY: `kind` names the struct `T` is (CGPoint for kAXValueCGPointType,
    // CGSize for kAXValueCGSizeType); AXValueGetValue checks the stored type
    // matches and writes only `size_of::<T>()` bytes into `out` when it does.
    let ok = unsafe { value.value(kind, NonNull::from(&mut out).cast()) };
    ok.then_some(out)
}

/// `AXPosition`, in global top-left-origin points.
pub fn position(element: &AXUIElement) -> Option<CGPoint> {
    ax_value(element, "AXPosition", AXValueType::CGPoint)
}

/// `AXSize`, in points.
pub fn size(element: &AXUIElement) -> Option<CGSize> {
    ax_value(element, "AXSize", AXValueType::CGSize)
}

/// The element's available actions (`AXPress`, `AXShowMenu`, …).
pub fn actions(element: &AXUIElement) -> Vec<String> {
    let mut names: *const CFArray = std::ptr::null();
    // SAFETY: `names` is a live local out-pointer, read only on success.
    let error = unsafe { element.copy_action_names(NonNull::from(&mut names)) };
    if error != AXError::Success {
        return Vec::new();
    }
    let Some(names) = NonNull::new(names.cast_mut()) else {
        return Vec::new();
    };
    // SAFETY: the Copy-rule result is ours to release, and action names are
    // documented to be an array of CFStrings (each is still downcast).
    let names: CFRetained<CFArray<CFType>> =
        unsafe { CFRetained::cast_unchecked(CFRetained::from_raw(names)) };
    (0..names.len())
        .filter_map(|index| names.get(index))
        .filter_map(|name| name.downcast_ref::<CFString>().map(ToString::to_string))
        .collect()
}

/// Whether an attribute can be written.
pub fn settable(element: &AXUIElement, name: &str) -> bool {
    let name = CFString::from_str(name);
    let mut settable: u8 = 0;
    // SAFETY: `settable` is a live local `Boolean` out-parameter.
    let error = unsafe { element.is_attribute_settable(&name, NonNull::from(&mut settable)) };
    error == AXError::Success && settable != 0
}

/// Performs an action. `Ok` means the app accepted it, not that it had an effect.
pub fn perform(element: &AXUIElement, action: &str) -> Result<(), i32> {
    let action = CFString::from_str(action);
    // SAFETY: both references are valid for the call.
    let error = unsafe { element.perform_action(&action) };
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

/// Writes a string attribute (`AXValue` of a text field).
pub fn set_string(element: &AXUIElement, name: &str, value: &str) -> Result<(), i32> {
    let name = CFString::from_str(name);
    let value = CFString::from_str(value);
    // SAFETY: both references are valid for the call.
    let error = unsafe { element.set_attribute_value(&name, &value) };
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

/// Writes a boolean attribute (`AXFrontmost`, `AXFocused`, `AXMain`).
pub fn set_bool(element: &AXUIElement, name: &str, value: bool) -> Result<(), i32> {
    let name = CFString::from_str(name);
    // SAFETY: both references are valid for the call; CFBoolean is static.
    let error = unsafe { element.set_attribute_value(&name, CFBoolean::new(value)) };
    if error == AXError::Success {
        Ok(())
    } else {
        Err(error.0)
    }
}

/// The deepest element at a global point, as seen from `root`.
pub fn element_at(root: &AXUIElement, x: f32, y: f32) -> Option<Element> {
    let mut hit: *const AXUIElement = std::ptr::null();
    // SAFETY: `hit` is a live local out-pointer, read only on success.
    let error = unsafe { root.copy_element_at_position(x, y, NonNull::from(&mut hit)) };
    if error != AXError::Success {
        return None;
    }
    let hit = NonNull::new(hit.cast_mut())?;
    // SAFETY: Copy-rule result, owned by us.
    Some(unsafe { CFRetained::from_raw(hit) })
}

/// The pid that owns an element.
pub fn pid(element: &AXUIElement) -> Option<i32> {
    let mut pid: libc::pid_t = 0;
    // SAFETY: `pid` is a live local out-parameter.
    let error = unsafe { element.pid(NonNull::from(&mut pid)) };
    (error == AXError::Success).then_some(pid)
}

/// Whether this process holds the Accessibility grant, optionally prompting.
pub fn is_trusted(prompt: bool) -> bool {
    // The documented key is `kAXTrustedCheckOptionPrompt`, whose value is this
    // string; spelling it avoids linking the extern static.
    let key = CFString::from_str("AXTrustedCheckOptionPrompt");
    let options =
        CFDictionary::<CFString, CFBoolean>::from_slices(&[&key], &[CFBoolean::new(prompt)]);
    // SAFETY: the dictionary is valid for the call and has the documented shape.
    unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) }
}

/// Puts up to 20 UTF-16 units of text on a keyboard event.
pub fn set_unicode(event: &CGEvent, units: &[u16]) {
    // SAFETY: `units` is a live slice and `len` is its exact length.
    unsafe { CGEvent::keyboard_set_unicode_string(Some(event), units.len() as _, units.as_ptr()) };
}

/// One entry of the Window Server's on-screen window list.
pub struct WindowInfo {
    pub id: u32,
    pub pid: i32,
    pub layer: i64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Absent without the Screen Recording grant.
    pub title: Option<String>,
}

/// On-screen windows, front to back.
///
/// Read directly rather than through `xcap`, because bounds, owner, and layer
/// need no permission while `xcap` skips every window whose title it cannot
/// read — which, without Screen Recording, is all of them.
pub fn window_list() -> Vec<WindowInfo> {
    use objc2_core_foundation::CFNumber;
    use objc2_core_graphics::{CGWindowListCopyWindowInfo, CGWindowListOption};

    let options =
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, 0) else {
        return Vec::new();
    };
    // SAFETY: the window list is documented as an array of CFDictionary with
    // CFString keys; each value is still downcast before it is read.
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> =
        unsafe { CFRetained::cast_unchecked(list) };
    let number = |dict: &CFDictionary<CFString, CFType>, key: &str| {
        dict.get(&CFString::from_str(key))
            .and_then(|value| value.downcast::<CFNumber>().ok())
            .and_then(|value| value.as_cgfloat())
    };
    let text = |dict: &CFDictionary<CFString, CFType>, key: &str| {
        dict.get(&CFString::from_str(key))
            .and_then(|value| value.downcast_ref::<CFString>().map(ToString::to_string))
    };
    (0..list.len())
        .filter_map(|index| list.get(index))
        .filter_map(|dict| {
            let bounds = dict
                .get(&CFString::from_str("kCGWindowBounds"))
                .and_then(|value| value.downcast::<CFDictionary>().ok())?;
            // SAFETY: `kCGWindowBounds` is a dictionary of CFString keys
            // (`X`, `Y`, `Width`, `Height`) to CFNumbers, downcast below.
            let bounds: CFRetained<CFDictionary<CFString, CFType>> =
                unsafe { CFRetained::cast_unchecked(bounds) };
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(WindowInfo {
                id: number(&dict, "kCGWindowNumber")? as u32,
                pid: number(&dict, "kCGWindowOwnerPID")? as i32,
                layer: number(&dict, "kCGWindowLayer").unwrap_or(0.0) as i64,
                x: number(&bounds, "X")?,
                y: number(&bounds, "Y")?,
                w: number(&bounds, "Width")?,
                h: number(&bounds, "Height")?,
                title: text(&dict, "kCGWindowName"),
            })
        })
        .collect()
}

/// Delivers pending run-loop work without waiting.
///
/// The helper has no app event loop, and `NSWorkspace` learns about launched,
/// quit, and activated apps through run-loop notifications; without a pump its
/// app list freezes at first use. One non-blocking pass before each query
/// keeps it current.
pub fn pump_run_loop() {
    use objc2_core_foundation::{kCFRunLoopDefaultMode, CFRunLoop};
    // SAFETY: reading an immutable CoreFoundation constant that is valid for
    // the life of the process.
    let mode = unsafe { kCFRunLoopDefaultMode };
    let _ = CFRunLoop::run_in_mode(mode, 0.0, false);
}

extern "C" {
    /// From `<spawn_private.h>`, exported by libSystem since macOS 10.14: a
    /// child spawned with this attribute is its own TCC "responsible
    /// process" instead of inheriting the app that started the chain.
    fn responsibility_spawnattrs_setdisclaim(
        attrs: *mut libc::posix_spawnattr_t,
        disclaim: libc::c_int,
    ) -> libc::c_int;
}

/// Runs `program` with `args` and `env` as its own responsible process,
/// inheriting the standard streams, and returns its exit code once it ends.
///
/// # Errors
///
/// The `errno` of a failed spawn or wait.
pub fn run_disclaimed(
    program: &std::ffi::CStr,
    args: &[std::ffi::CString],
    env: &[std::ffi::CString],
) -> Result<i32, i32> {
    let mut arg_ptrs: Vec<*mut libc::c_char> = args.iter().map(|a| a.as_ptr().cast_mut()).collect();
    arg_ptrs.push(std::ptr::null_mut());
    let mut env_ptrs: Vec<*mut libc::c_char> = env.iter().map(|e| e.as_ptr().cast_mut()).collect();
    env_ptrs.push(std::ptr::null_mut());
    let mut attrs: libc::posix_spawnattr_t = std::ptr::null_mut();
    // SAFETY: `attrs` is a valid out-pointer; it is destroyed below on every
    // path after a successful init.
    let error = unsafe { libc::posix_spawnattr_init(&raw mut attrs) };
    if error != 0 {
        return Err(error);
    }
    // SAFETY: `attrs` was initialized above.
    let error = unsafe { responsibility_spawnattrs_setdisclaim(&raw mut attrs, 1) };
    let mut pid: libc::pid_t = 0;
    let error = if error == 0 {
        // SAFETY: `program`, `arg_ptrs`, and `env_ptrs` are NUL-terminated and
        // outlive the call; both end in a null pointer as
        // `posix_spawn` requires; `attrs` is initialized.
        unsafe {
            libc::posix_spawn(
                &raw mut pid,
                program.as_ptr(),
                std::ptr::null(),
                &raw const attrs,
                arg_ptrs.as_ptr(),
                env_ptrs.as_ptr(),
            )
        }
    } else {
        error
    };
    // SAFETY: `attrs` was initialized above and is not used again.
    unsafe { libc::posix_spawnattr_destroy(&raw mut attrs) };
    if error != 0 {
        return Err(error);
    }
    let mut status: libc::c_int = 0;
    loop {
        // SAFETY: `pid` is our own child and `status` a valid out-pointer.
        if unsafe { libc::waitpid(pid, &raw mut status, 0) } == pid {
            break;
        }
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if errno != libc::EINTR {
            return Err(errno);
        }
    }
    Ok(if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        128 + libc::WTERMSIG(status)
    })
}
