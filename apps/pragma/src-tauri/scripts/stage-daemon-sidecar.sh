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

# macOS: the linker gives a debug binary only a `linker-signed` ad hoc
# signature, which System Settings silently refuses to add to Accessibility or
# Screen Recording. Re-sign the computer-use helper ad hoc under its stable
# identifier so a dev build can be granted. Only a fresh link is re-signed, so
# an unchanged binary keeps its hash and its grant. Release bundles are signed
# by the Tauri bundler instead.
if [[ "$profile" == "debug" && "$(uname -s)" == "Darwin" ]]; then
  helper="$repo_root/target/debug/pragma-computer"
  if codesign -dv "$helper" 2>&1 | grep -q "linker-signed"; then
    helper_id="$(sed -n 's/.*"macHelperBundleId": *"\([^"]*\)".*/\1/p' "$repo_root/packages/constants/values.json")"
    codesign --force --sign - --identifier "$helper_id" "$helper"
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
