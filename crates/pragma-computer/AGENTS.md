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
- **`unsafe` lives only in `src/macos/ffi.rs`** — the second documented
  exception to the workspace deny, approved for computer-use FFI. Every block
  carries a `// SAFETY:` comment; everything above it is safe code. A new FFI
  call goes there as a safe wrapper.
- **The `native` feature gates platform code.** `pragma-server` depends on this
  crate with `default-features = false` (protocol + fake backend only), so the
  daemon never links AppKit or a capture stack. The binary requires `native`.
- **A platform without a backend fails loudly** (`unsupportedPlatform`), never
  with an empty result. Windows (UI Automation, `SendInput`, WGC) is not built yet.
- **The helper is two processes on macOS.** The outer one only waits on its
  disclaimed re-run; the inner one serves and exits within 50 ms of being
  orphaned, so killing the pid the server holds still stops every native call.
- **Prefer element actions to synthetic input.** `AXPress` / setting `AXValue`
  work on background windows and never move the user's pointer. Pointer and
  keyboard paths activate the target and re-check it is frontmost before every
  event; check the `StopFlag` between events.
- **Never read a secure field's value**, and never put typed text anywhere but
  the target app.
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
  (`macos/responsible.rs`), so Accessibility and Screen Recording attach to the
  `pragma-computer` binary itself — in dev, `target/debug/pragma-computer`, not
  the app or terminal that started the chain. System Settings silently refuses a
  `linker-signed` binary, so `stage-daemon-sidecar.sh` (run by `bun run dev`)
  re-signs a freshly linked debug helper ad hoc as `macHelperBundleId`; after a
  manual `cargo build` run
  `codesign --force --sign - --identifier com.pragma.computer-use target/debug/pragma-computer`.
  An ad hoc build is identified by its hash, so a rebuild needs the grant re-added. Shipping it as
  `Pragma Computer Use.app` (bundle id `constants.computer.macHelperBundleId`)
  for a named, stable identity is still planned.
- Capture uses `xcap`'s deprecated `CGWindowListCreateImage`; ScreenCaptureKit is
  the planned upgrade.
- Chords use ANSI key codes with the character attached; a layout-aware mapping
  (`UCKeyTranslate`) is planned.
- Jev-driven `computer run` tasks, the SDK `client.computer` namespace (needs a
  local-scope gateway token), and Windows parity are later phases.
