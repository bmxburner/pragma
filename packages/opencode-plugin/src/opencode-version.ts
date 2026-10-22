import type { PluginContext } from "@pragma-sh/plugin/catalog";

import { pluginCwd } from "./cwd";
import { runOnHost } from "./host-shell";

/**
 * OpenCode v1 and v2 differ in everything Pragma drives outside the TUI: v2
 * keeps credentials in its database behind a background service, dropped
 * `opencode db`, and reads a different plugin API. Account and usage callbacks
 * ask which one is installed before they act.
 *
 * Cached briefly per working directory (one host each), so a burst of account
 * callbacks costs one `opencode --version`, while an upgrade is still noticed.
 */
const VERSION_TTL_MS = 60_000;
const versions = new Map<string, { major: number; checkedAt: number }>();

/** The major version in `opencode --version` output (`1.19.3`, `opencode v2.1.1`), or 0. */
function parseOpenCodeMajor(output: string): number {
  const match = /(\d+)\.\d+\.\d+/.exec(output);
  return match ? Number(match[1]) : 0;
}

/** Whether the host's OpenCode is v2 or newer. A missing or unreadable `opencode` is v1. */
export async function isOpenCodeV2(ctx: PluginContext): Promise<boolean> {
  const key = pluginCwd(ctx);
  const cached = versions.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < VERSION_TTL_MS) return cached.major >= 2;
  const result = await runOnHost(ctx, "opencode --version");
  const major = result.status === 0 ? parseOpenCodeMajor(result.stdout) : 0;
  versions.set(key, { major, checkedAt: now });
  return major >= 2;
}

/** Forgets cached versions. For tests. */
export function resetOpenCodeVersionCache(): void {
  versions.clear();
}
