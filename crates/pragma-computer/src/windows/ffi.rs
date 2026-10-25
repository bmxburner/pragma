//! Safe wrappers over UI Automation, `SendInput`, and Win32 application management.
//! All Windows unsafe code stays here. COM objects stay on the helper's MTA thread.
#![allow(unsafe_code)]
use crate::snapshot::RawNode;
use crate::{failure, ComputerResult};
use pragma_constants::{ComputerErrorCode, ComputerMouseButton, ComputerPoint, ComputerRect};
use std::mem::size_of;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, POINT};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationInvokePattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
    TreeScope_Element, UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId,
    UIA_ControlTypePropertyId, UIA_HasKeyboardFocusPropertyId, UIA_InvokePatternId,
    UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
    UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId, UIA_ValuePatternId,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow, ShowWindow,
    WindowFromPoint, SW_RESTORE, SW_SHOWNORMAL,
};

pub type Element = IUIAutomationElement;
fn hwnd(raw: u32) -> HWND {
    HWND(raw as usize as *mut std::ffi::c_void)
}
fn error(_: windows::core::Error) -> pragma_constants::ComputerFailure {
    failure(
        ComputerErrorCode::ElementStale,
        "The accessibility element is no longer available",
    )
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// UIA interfaces are released before the apartment is uninitialized.
pub struct Automation {
    api: Option<IUIAutomation>,
    cache: Option<IUIAutomationCacheRequest>,
    walker: Option<IUIAutomationTreeWalker>,
}
impl Automation {
    pub fn new() -> ComputerResult<Self> {
        // SAFETY: the helper's worker thread has no COM apartment; successful init is balanced in Drop.
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(error)?;
        }
        // SAFETY: process-local setting, before any window/capture calls. A manifest can already have set it.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        // SAFETY: CUIAutomation is an in-process COM class created on the initialized MTA.
        let api: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(error)?;
        // SAFETY: retained interfaces; every added property has its correctly typed UIA id.
        let (cache, walker) = unsafe {
            let cache = api.CreateCacheRequest().map_err(error)?;
            cache.SetTreeScope(TreeScope_Element).map_err(error)?;
            for id in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_LocalizedControlTypePropertyId,
                UIA_AutomationIdPropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsPasswordPropertyId,
                UIA_IsOffscreenPropertyId,
            ] {
                cache.AddProperty(id).map_err(error)?;
            }
            (cache, api.ControlViewWalker().map_err(error)?)
        };
        Ok(Self {
            api: Some(api),
            cache: Some(cache),
            walker: Some(walker),
        })
    }
    pub fn root(&self, window: u32) -> ComputerResult<Element> {
        let api = self
            .api
            .as_ref()
            .ok_or_else(|| failure(ComputerErrorCode::Internal, "UIA unavailable"))?;
        // SAFETY: HWNDs are borrowed; UIA validates a window that has closed and returns an error.
        unsafe { api.ElementFromHandle(hwnd(window)) }.map_err(error)
    }
    pub fn children(&self, element: &Element, max: usize) -> Vec<Element> {
        let (Some(walker), Some(cache)) = (&self.walker, &self.cache) else {
            return vec![];
        };
        let mut children = vec![];
        // SAFETY: all elements and cache interfaces are retained on this MTA thread.
        unsafe {
            let mut next = walker.GetFirstChildElementBuildCache(element, cache);
            while let Ok(child) = next {
                if children.len() >= max {
                    break;
                }
                next = walker.GetNextSiblingElementBuildCache(&child, cache);
                children.push(child);
            }
        }
        children
    }
    pub fn node(
        &self,
        element: &Element,
        path: Vec<u64>,
        ancestor_roles: Vec<String>,
    ) -> ComputerResult<RawNode> {
        let cache = self
            .cache
            .as_ref()
            .ok_or_else(|| failure(ComputerErrorCode::Internal, "UIA unavailable"))?;
        // SAFETY: cache and element are retained UIA interfaces on the same initialized thread.
        unsafe {
            let e = element.BuildUpdatedCache(cache).map_err(error)?;
            // A failed password-property read is treated as secure. Never probe a value first.
            let secure = e
                .CachedIsPassword()
                .map_or(true, windows::core::BOOL::as_bool);
            let pattern: Option<IUIAutomationValuePattern> = if secure {
                None
            } else {
                element.GetCurrentPatternAs(UIA_ValuePatternId).ok()
            };
            let role = control_role(e.CachedControlType().map(|id| id.0).unwrap_or_default());
            let editable = role == "Edit"
                || pattern
                    .as_ref()
                    .is_some_and(|v| v.CurrentIsReadOnly().is_ok_and(|v| !v.as_bool()));
            let value = pattern
                .as_ref()
                .and_then(|v| v.CurrentValue().ok())
                .map(|v| v.to_string());
            let r = e.CachedBoundingRectangle().ok();
            let actions = if element
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok()
            {
                vec!["press".to_string()]
            } else {
                vec![]
            };
            Ok(RawNode {
                role: role.to_string(),
                title: e.CachedName().ok().map(|s| s.to_string()),
                identifier: e.CachedAutomationId().ok().map(|s| s.to_string()),
                frame: r.map(|r| ComputerRect {
                    x: f64::from(r.left),
                    y: f64::from(r.top),
                    w: f64::from(r.right - r.left),
                    h: f64::from(r.bottom - r.top),
                    display_id: None,
                }),
                offscreen: e
                    .CachedIsOffscreen()
                    .map_or(true, windows::core::BOOL::as_bool),
                enabled: e.CachedIsEnabled().is_ok_and(windows::core::BOOL::as_bool),
                focused: e
                    .CachedHasKeyboardFocus()
                    .is_ok_and(windows::core::BOOL::as_bool),
                secure,
                editable,
                value,
                actions,
                path,
                ancestor_roles,
                ..RawNode::default()
            })
        }
    }
}
impl Drop for Automation {
    fn drop(&mut self) {
        self.walker.take();
        self.cache.take();
        self.api.take();
        // SAFETY: balances this thread's successful CoInitializeEx after releasing its interfaces.
        unsafe {
            CoUninitialize();
        }
    }
}
/// Invoke supports background controls without changing the physical cursor.
pub fn invoke(element: &Element) -> ComputerResult<()> {
    // SAFETY: retained interface; UIA validates the pattern and the element's current liveness.
    unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .and_then(|p| p.Invoke())
    }
    .map_err(error)
}
pub fn set_value(element: &Element, text: &str) -> ComputerResult<()> {
    let text = windows::core::BSTR::from(text);
    // SAFETY: a retained UIA interface and a null-terminated UTF-16 buffer live through the call.
    unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|p| p.SetValue(&text))
    }
    .map_err(error)
}
pub fn focus_element(element: &Element) -> ComputerResult<()> {
    // SAFETY: retained interface, on its apartment thread.
    unsafe { element.SetFocus() }.map_err(error)
}
pub fn foreground_pid() -> Option<u64> {
    let mut pid = 0;
    // SAFETY: the output points to a live u32; HWND is obtained from Windows.
    unsafe {
        GetWindowThreadProcessId(GetForegroundWindow(), Some(&raw mut pid));
    }
    (pid != 0).then_some(u64::from(pid))
}
pub fn activate(window: u32) -> ComputerResult<()> {
    // SAFETY: Win32 validates borrowed HWNDs. No pointers are dereferenced by Rust.
    unsafe {
        let _ = ShowWindow(hwnd(window), SW_RESTORE);
        if !SetForegroundWindow(hwnd(window)).as_bool() {
            return Err(failure(
                ComputerErrorCode::TargetChanged,
                "Windows refused foreground activation",
            ));
        }
    }
    Ok(())
}
pub fn process_path(pid: u32) -> Option<String> {
    // SAFETY: limited-query process handle is closed on every path; buffer length matches its capacity.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0_u16; 32768];
        let mut len = 32768;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut len,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..len as usize]))
    }
}
pub fn refuse_elevated(pid: u32) -> ComputerResult<()> {
    // SAFETY: handles returned by Windows are closed; TOKEN_ELEVATION and its length match the query.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| {
            failure(
                ComputerErrorCode::TargetElevated,
                "Target process cannot be queried",
            )
        })?;
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &raw mut token);
        let _ = CloseHandle(process);
        opened.map_err(|_| {
            failure(
                ComputerErrorCode::TargetElevated,
                "Target token cannot be queried",
            )
        })?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut needed = 0;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            u32::try_from(size_of::<TOKEN_ELEVATION>()).unwrap_or(u32::MAX),
            &raw mut needed,
        );
        let _ = CloseHandle(token);
        result.map_err(|_| {
            failure(
                ComputerErrorCode::TargetElevated,
                "Target elevation cannot be checked",
            )
        })?;
        if elevation.TokenIsElevated != 0 {
            return Err(failure(
                ComputerErrorCode::TargetElevated,
                "Elevated applications are not controlled",
            ));
        }
    }
    Ok(())
}
pub fn launch(app: &str, argument: Option<&str>) -> ComputerResult<()> {
    let file = wide(app);
    let args = argument.map(wide);
    // SAFETY: all string buffers are null-terminated and live until ShellExecuteW returns.
    let status = unsafe {
        ShellExecuteW(
            None,
            PCWSTR::null(),
            PCWSTR(file.as_ptr()),
            args.as_ref().map_or(PCWSTR::null(), |a| PCWSTR(a.as_ptr())),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if status.0 as usize <= 32 {
        return Err(failure(
            ComputerErrorCode::AppNotFound,
            "Windows could not open that application",
        ));
    }
    Ok(())
}
fn send(input: INPUT) -> ComputerResult<()> {
    // SAFETY: the slice contains one fully initialized INPUT with the matching union tag and ABI size.
    let sent = unsafe {
        SendInput(
            &[input],
            i32::try_from(size_of::<INPUT>()).unwrap_or(i32::MAX),
        )
    };
    if sent != 1 {
        return Err(failure(
            ComputerErrorCode::TargetElevated,
            "Windows refused synthetic input (UIPI or secure desktop)",
        ));
    }
    Ok(())
}
pub fn key(vk: u16, unit: u16, unicode: bool, up: bool) -> ComputerResult<()> {
    let flags = if unicode {
        KEYEVENTF_UNICODE
    } else {
        KEYBD_EVENT_FLAGS(0)
    } | if up {
        KEYEVENTF_KEYUP
    } else {
        KEYBD_EVENT_FLAGS(0)
    };
    send(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: unit,
                dwFlags: flags,
                ..KEYBDINPUT::default()
            },
        },
    })
}
pub fn move_to(point: &ComputerPoint) -> ComputerResult<()> {
    // SAFETY: scalar screen coordinates, no pointers; PMv2 means physical virtual-screen pixels.
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SetCursorPos(
            screen_coordinate(point.x),
            screen_coordinate(point.y),
        )
    }
    .map_err(error)
}
pub fn button(button: ComputerMouseButton, up: bool) -> ComputerResult<()> {
    let flag = match (button, up) {
        (ComputerMouseButton::Left, false) => MOUSEEVENTF_LEFTDOWN,
        (ComputerMouseButton::Left, true) => MOUSEEVENTF_LEFTUP,
        (ComputerMouseButton::Right, false) => MOUSEEVENTF_RIGHTDOWN,
        (ComputerMouseButton::Right, true) => MOUSEEVENTF_RIGHTUP,
        (ComputerMouseButton::Middle, false) => MOUSEEVENTF_MIDDLEDOWN,
        (ComputerMouseButton::Middle, true) => MOUSEEVENTF_MIDDLEUP,
    };
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flag,
                ..MOUSEINPUT::default()
            },
        },
    })
}
pub fn scroll(delta: i32, horizontal: bool) -> ComputerResult<()> {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: if horizontal {
                    MOUSEEVENTF_HWHEEL
                } else {
                    MOUSEEVENTF_WHEEL
                },
                mouseData: delta.cast_unsigned(),
                ..MOUSEINPUT::default()
            },
        },
    })
}
pub fn pointer() -> Option<ComputerPoint> {
    let mut point = POINT::default();
    // SAFETY: writable stack POINT, read only after success.
    unsafe { GetCursorPos(&raw mut point) }.ok()?;
    Some(ComputerPoint {
        x: f64::from(point.x),
        y: f64::from(point.y),
    })
}
pub fn point_pid(point: &ComputerPoint) -> Option<u64> {
    let mut pid = 0;
    // SAFETY: point is by value; output points to a live u32 and Windows validates the HWND.
    unsafe {
        GetWindowThreadProcessId(
            WindowFromPoint(POINT {
                x: screen_coordinate(point.x),
                y: screen_coordinate(point.y),
            }),
            Some(&raw mut pid),
        );
    }
    (pid != 0).then_some(u64::from(pid))
}
pub fn held_keyboard() -> bool {
    // SAFETY: GetAsyncKeyState takes a scalar VK; this reads current key-down state only.
    (8..=254)
        .filter(|key| !matches!(key, 0x01..=0x06))
        .any(|key| unsafe { GetAsyncKeyState(key) } < 0)
}
pub fn held_pointer() -> bool {
    // SAFETY: scalar mouse VKs; pointer movement itself never counts as takeover.
    [1, 2, 4, 5, 6]
        .into_iter()
        .any(|key| unsafe { GetAsyncKeyState(key) } < 0)
}

// Win32 coordinates are signed physical pixels. Saturation/rounding matches the API.
#[allow(clippy::cast_possible_truncation)]
fn screen_coordinate(value: f64) -> i32 {
    value.round() as i32
}

fn control_role(kind: i32) -> &'static str {
    match kind {
        50000 | 50031 => "Button",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50023 => "Tree",
        50024 | 50029 => "DataItem",
        50026 => "Group",
        50028 => "DataGrid",
        50030 => "Document",
        50032 => "Window",
        _ => "Pane",
    }
}

/// The package identity, when this is a Store application.
pub fn process_aumid(pid: u32) -> Option<String> {
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    // SAFETY: a limited-query handle is closed on every path, and Windows sizes
    // the output buffer before writing UTF-16 into its allocated capacity.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut len = 0;
        let _ = GetApplicationUserModelId(process, &raw mut len, None);
        if len == 0 || len > 32768 {
            let _ = CloseHandle(process);
            return None;
        }
        let mut value = vec![0_u16; len as usize];
        let result =
            GetApplicationUserModelId(process, &raw mut len, Some(PWSTR(value.as_mut_ptr())));
        let _ = CloseHandle(process);
        if result.0 != 0 {
            return None;
        }
        Some(String::from_utf16_lossy(
            &value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())],
        ))
    }
}
