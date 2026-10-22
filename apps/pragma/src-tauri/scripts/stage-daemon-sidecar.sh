#!/usr/bin/env bash
set -euo pipefail

# Build the persistent server (`pragma-server`), CLI helper (`pragma-cli`), and
# computer-use helper (`pragma-computer`), then stage sidecars/resources so the bundle is self-contained. The release app launches the server
# from beside its own executable (see `sidecar_executable()` in
# `src-tauri/src/pty.rs`), and the Tauri CLI only copies it there if a
# `pragma-server-<target-triple>` binary exists under `src-tauri/binaries/`;
# the app installs `pragma-cli` from its sibling sidecar on startup.
#
# Pass `--release` for production builds (`tauri build`). The default debug
# build keeps `tauri dev` fast: dev runs the server via `cargo run`, so the
# staged binary merely satisfies the sidecar copy step the CLI performs for
# every `externalBin`.
#
# Runs on macOS, Linux, and Windows (under Git Bash, which is what the
# `windows-latest` CI runner provides). On Windows every produced binary carries
# a `.exe` suffix, and Tauri expects the staged name to carry it too, for example
# `pragma-server-aarch64-pc-windows-msvc.exe` on a Windows ARM64 runner.

profile="debug"
if [[ "${1:-}" == "--release" ]]; then
  profile="release"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_tauri_dir="$(cd "$script_dir/.." && pwd)"      # apps/pragma/src-tauri
repo_root="$(cd "$src_tauri_dir/../../.." && pwd)" # workspace root

triple="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$triple" ]]; then
  echo "stage-daemon-sidecar: could not determine host target triple" >&2
  exit 1
fi

# Executable suffix for this host. Everything below appends it to both the
# source and staged names rather than assuming an extensionless binary.
exe=""
if [[ "$triple" == *windows* ]]; then
  exe=".exe"
fi

# Rust sidecars, built from this workspace. `pragma-computer` is the native
# computer-use helper `pragma-server` supervises; it must sit beside the server.
rust_sidecars=(pragma-server pragma-gateway pragma-cli pragma-computer)

# `set -u` makes an empty array expansion an error on the bash 3.2 that ships
# with macOS, so the profile flag is passed as a plain (possibly empty) word.
cargo_profile_flag=""
if [[ "$profile" == "release" ]]; then
  cargo_profile_flag="--release"
fi
for crate in "${rust_sidecars[@]}"; do
  # shellcheck disable=SC2086 # intentionally unquoted: empty means "no flag"
  cargo build -p "$crate" $cargo_profile_flag
done

# macOS: System Settings will not grant Accessibility or Screen Recording to a
# bare debug binary (it carries only a `linker-signed` ad hoc signature, and
# the list refuses it). Wrap the computer-use helper in a minimal app bundle
# beside it, which `pragma-server` prefers (`helper_path`), and sign the bundle
# ad hoc under the helper's bundle id. The bundle is rebuilt only when the
# binary changed, so an unchanged helper keeps its hash and its grants.
if [[ "$profile" == "debug" && "$(uname -s)" == "Darwin" ]]; then
  values="$repo_root/packages/constants/values.json"
  helper_id="$(sed -n 's/.*"macHelperBundleId": *"\([^"]*\)".*/\1/p' "$values")"
  helper_app_name="$(sed -n 's/.*"macHelperAppName": *"\([^"]*\)".*/\1/p' "$values")"
  helper="$repo_root/target/debug/pragma-computer"
  bundle="$repo_root/target/debug/$helper_app_name.app"
  bundled_helper="$bundle/Contents/MacOS/pragma-computer"
  if [[ ! -f "$bundled_helper" || "$helper" -nt "$bundled_helper" ]]; then
    rm -rf "$bundle"
    mkdir -p "$bundle/Contents/MacOS"
    cp "$helper" "$bundled_helper"
    cat >"$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$helper_id</string>
  <key>CFBundleName</key><string>$helper_app_name</string>
  <key>CFBundleExecutable</key><string>pragma-computer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
    codesign --force --sign - --identifier "$helper_id" "$bundle"
    echo "bundled pragma-computer -> target/debug/$helper_app_name.app"
  fi
fi

# Bun-compiled sidecars: `<workspace filter>:<package dir>:<binary name>`.
# A debug app runs several of these from source via `bun`, but the binary must
# still exist so the Tauri CLI's externalBin copy step succeeds.
bun_sidecars=(
  "@pragma-sh/ai-helpers:ai-helpers:pragma-ai"
  "@pragma-sh/github-helpers:github-helpers:pragma-github"
  "@pragma-sh/watcher:watcher:pragma-watch"
  "@pragma-sh/automations:automations:pragma-automations"
  "@pragma-sh/plugins-host:plugins-host:pragma-plugins"
)

bun --filter @pragma-sh/ai-helpers build:sidecar
bun --filter @pragma-sh/github-helpers build:sidecar
bun --filter @pragma-sh/watcher build:sidecar
bun --filter @pragma-sh/automations build:sidecar
# The plugin catalog sidecar bundles `@pragma-sh/sdk` and `@pragma-sh/plugin`, which
# resolve to their built `dist/`; build its workspace dependencies first.
bunx turbo run build --filter=@pragma-sh/plugins-host^...
bun --filter @pragma-sh/plugins-host build:sidecar

mkdir -p "$src_tauri_dir/binaries"

stage() {
  local source="$1"
  local name="$2"
  if [[ ! -f "$source" ]]; then
    echo "stage-daemon-sidecar: missing $source" >&2
    exit 1
  fi
  cp "$source" "$src_tauri_dir/binaries/$name-$triple$exe"
  echo "staged $name -> src-tauri/binaries/$name-$triple$exe"
}

for crate in "${rust_sidecars[@]}"; do
  stage "$repo_root/target/$profile/$crate$exe" "$crate"
done

for entry in "${bun_sidecars[@]}"; do
  IFS=':' read -r _filter package binary <<<"$entry"
  stage "$repo_root/packages/$package/dist/$binary$exe" "$binary"
done

rm -rf "$src_tauri_dir/resources/pragma/agents"
