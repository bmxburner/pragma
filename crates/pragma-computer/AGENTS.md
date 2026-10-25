# crates/pragma-computer — native computer use

The native half of computer use: accessibility snapshots, screen capture, and
synthetic input behind one `ComputerBackend` trait, plus the `pragma-computer`
helper binary that `pragma-server` spawns and supervises.

## Where things live

| Concern                                                                                        | Where                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Wire contract (requests, snapshots, errors, activity)                                          | `packages/constants` (`Computer*` types, `constants.computer`)                                                                     |
| Pure rules: leases, policy, blocked/sensitive targets, chords, geometry, revalidation          | `crates/pragma-core/src/computer.rs`                                                                                               |
| Sessions, leases, approvals, the stop, the `computer` RPC, `computerActivity`                  | `crates/pragma-server/src/computer/`                                                                                               |
| Helper supervision (spawn, NDJSON, crash backoff)                                              | `crates/pragma-server/src/computer/helper.rs`                                                                                      |
| This crate: backends, helper protocol + serve loop, fake backend                               | `src/`                                                                                                                             |
| CLI                                                                                            | `crates/pragma-cli/src/computer.rs`                                                                                                |
| Desktop: in-app PiP panel, cursor overlay windows, approvals, sidebar, Settings, stop shortcut | `apps/pragma/src-tauri/src/computer.rs`, `apps/pragma/src/components/computer-use/`, `apps/pragma/src/state/computer-use-store.ts` |

## Rules

- **The helper owns every native call; the server owns everything else.** No
  session, lease, or policy state here. A crash or a hung accessibility call
  costs one in-flight request, never a terminal session.
- **`unsafe` lives only in `src/{macos,windows}/ffi.rs`** — the second documented
  exception to the workspace deny, approved for computer-use FFI. Every block
  carries a `// SAFETY:` comment; everything above it is safe code. A new FFI
  call goes there as a safe wrapper.
- **The `native` feature gates platform code.** `pragma-server` depends on this
  crate with `default-features = false` (protocol + fake backend only), so the
  daemon never links AppKit or a capture stack. The binary requires `native`.
- **A platform without a backend fails loudly** (`unsupportedPlatform`), never
  with an empty result. Windows uses cached UI Automation plus guarded Unicode `SendInput`; Linux remains unsupported.
- **The helper is two processes on macOS.** The outer one only waits on its
  disclaimed re-run; the inner one serves and exits within 50 ms of being
  orphaned, so killing the pid the server holds still stops every native call.
- **Prefer element actions to synthetic input.** `AXPress` / setting `AXValue`
  work on background windows and never move the user's pointer. Check the
  `StopFlag` between events.
- **Input is delivered in the background** (`macos/background.rs`): keys,
  clicks, and scrolls are posted to the target pid through the private
  `SLEventPostToPid`, with the target window id in the routing fields
  (40/51/91/92/58) and a focus-without-raise record before a click — the app is
  never activated or raised and the user's pointer never moves. The SkyLight
  symbols live in `ffi.rs`'s `SkyLight` section, resolved with `dlsym` and all
  optional. Keys go to the app's _key_ window, which a background app loses as
  soon as the user works elsewhere — keys then "succeed" and do nothing — so
  `key` and `type` send the same focus-without-raise record to the app's front
  window first (`focus_for_keys`), and `type --element` also focuses the element
  through AX. `scroll --element` skips the "something covers it" check on the
  background path (it is addressed to the window), keeping it only before the
  HID fallback moves the pointer. Command chords go out
  without the authentication message (AppKit only fires menu key equivalents
  on that path), other keys with it (Chromium drops unauthenticated keys).
  Only drags, and clicks with no window of the app under the point or a refused
  focus record (status 1002 latches background pointer input off), fall back to
  activating the target and posting HID events after re-checking it is
  frontmost. Private API: re-verify on every major macOS release.
- **Takeover is scoped to the target app.** `userActivity` reports seconds since
  the last physical key press and since the last click/drag/scroll (pointer
  movement alone never counts), plus whether the target is frontmost and owns
  the topmost window under the pointer; `pragma_core::computer::is_user_takeover`
  decides. Typing or clicking in another app never pauses an agent. Events the
  helper itself posted to a pid may show up in that HID state, so a reading no
  newer than the helper's own last background post is not attributed to the
  user.
- **Cursor overlays must never activate Pragma.** They use `.focused(false)`
  and `.focusable(false)`. `vendor/wry` patches the macOS constructor to honor
  the first setting instead of unconditionally activating the app and changing
  its keyboard responder. Early preparation avoids missing cursor events, but
  first-session or mid-run creation must also preserve the user's focus.
- **Never read a secure field's value**, and never put typed text anywhere but
  the target app.
- **A locked Mac has no displays.** With the session locked or the displays
  asleep, `CGGetActiveDisplayList` (behind `xcap::Monitor::all`) returns zero
  displays, so `displays` is `[]`, captures fail, and the desktop creates no
  cursor overlay. That is expected, not a bug; the overlays are retried on the
  next activity event. Check `CGSessionCopyCurrentDictionary`'s
  `CGSSessionScreenIsLocked` before debugging a missing cursor.
- **Window listing reads `CGWindowListCopyWindowInfo` directly** (no Screen
  Recording needed for bounds/owner/layer); `xcap` is used for capture only.
  `NSWorkspace.frontmostApplication` is stale in this run-loop-less process —
  use `apps::frontmost_pid`, which reads the window list.

## Testing

`cargo test -p pragma-computer` (pure snapshot/capture/protocol tests) and
`cargo test -p pragma-server computer` (the full RPC against `FakeBackend`).
Live native paths need the helper's Accessibility and Screen Recording grants;
exercise them by piping NDJSON into `target/debug/pragma-computer`, or through
`pragma-cli computer` against a dev server. Without the grants, `inspect`,
`screenshot`, and input fail with `permissionMissing` — that is expected, not a bug.

## Known gaps (planned)

- macOS TCC identity: the helper re-runs itself with responsibility disclaimed
  (`macos/responsible.rs`), so the grants attach to the helper, not the app or
  terminal that started the chain. System Settings refuses a bare ad hoc binary,
  so in dev `stage-daemon-sidecar.sh` (run by `bun run dev`) wraps it in
  `target/debug/<macHelperAppName>.app` (bundle id `macHelperBundleId`, signed
  ad hoc), and `pragma-server` prefers that bundle when it sits beside it
  (`helper_path`). It shows in System Settings as "Pragma Computer Use". An ad
  hoc bundle is identified by its hash, so a rebuilt helper needs the grants
  re-added — remove the entry with **−** and add it again, since toggling keeps
  the old hash. To stop re-granting on every rebuild, export
  `PRAGMA_DEV_SIGNING_IDENTITY` (any codesigning identity from
  `security find-identity -v -p codesigning`, e.g. "Apple Development: …"): the
  grants then follow the certificate and survive rebuilds. After successful
  signing, staging remembers the identity in the gitignored
  `apps/pragma/src-tauri/dev-signing-identity.local`; an explicit environment
  value overrides it. This keeps builds from another terminal on the same
  certificate. A filesystem sandbox
  may hide the login keychain and report zero identities: run staging with
  keychain access, preserving the configured identity. Never leave an ad hoc
  staged bundle as a workaround for a configured certificate's signing failure.
  macOS caches Accessibility denial in a running helper. A
  subsequent `permissions` check automatically refreshes a helper that last
  reported a missing macOS grant, once no native requests are in flight.
  Settings checks again on window focus. `stage-macos-helper.ts` also stages the release bundle under `Contents/Helpers`, signing it before Tauri signs the outer app (custom files are not recursively signed by Tauri). A CI certificate uses a temporary keychain, removed in `finally`.
- macOS 14+ capture uses `SCScreenshotManager` with explicit Pragma-window exclusions and output scaling. Older macOS falls back to `xcap`; Windows capture still uses `xcap`. Native SCStream/WGC video transport remains a follow-up; desktop preview channels stream JPEG screenshots.
- Chords use ANSI key codes with the character attached; a layout-aware mapping
  (`UCKeyTranslate`) is planned.
- The host owns durable Jev tasks and the SDK namespace behind a separate local gateway credential. Native Windows/mixed-DPI/fullscreen testing and signed-helper notarization need the release validation matrix.

## Windows backend

`src/windows/ffi.rs` owns MTA initialization, cached UIA property reads, Invoke/Value patterns, elevation checks, and Win32 input. `input.rs` checks stop/focus between down events and always releases held keys/buttons. `mod.rs` handles app/window resolution and snapshot revalidation; `windows.manifest` declares PerMonitorV2 and asInvoker. `windows.rc` embeds that manifest and the helper's cursor icon. Only the helper links these APIs; the server still builds with native features disabled.

Windows takeover currently detects held keys/buttons, not recent wheel events. Foreground and capture behavior must be exercised on Windows 10/11 with mixed DPI; passing a source cross-check is not that validation.

Session cancellation uses `inSession` and reader-thread `setSessionPaused`. `StopFlag` captures a session epoch when queued: pause/resume invalidates older actions without stopping other sessions. Native event-boundary checks also probe physical input in the target pid; the server turns `userTakeover` into a durable pause. Keep modifier/button releases unconditional when interrupted.

`ComputerBackend::permissions` takes `ComputerPermissionsRequest`. Its optional
`permission` selects which macOS grant to prompt for when `request` is true;
omitting it preserves the CLI's request-both behavior. Checks always report both.

On macOS, `CGRequestScreenCaptureAccess` may return denied without showing another
prompt. An explicit Screen Recording request also opens the matching System
Settings pane when access is still missing. Passive permission polling must never
open Settings, and an Accessibility-only request must not open Screen Recording.

## Helper icon

`icons/icon.svg` is the cursor artwork; generated `icon.icns` and `icon.ico` ship
with the macOS helper bundle and Windows executable. Regenerate from the repo root:

```sh
bunx --no-install tauri icon crates/pragma-computer/icons/icon.svg --output /tmp/pragma-computer-icons
cp /tmp/pragma-computer-icons/icon.{icns,ico} crates/pragma-computer/icons/
```

macOS staging copies the icon into `Contents/Resources` and sets `CFBundleIconFile`
before signing. Its cache hashes the binary, signing identity, Info.plist, and icon;
artwork or metadata changes must rebuild the bundle even when the binary is unchanged.
