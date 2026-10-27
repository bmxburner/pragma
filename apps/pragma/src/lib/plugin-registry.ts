import { officialPluginLock, type LockedPlugin } from "@pragma-sh/plugin-registry";

import { installOfficialPlugin } from "@/lib/tauri";

const OFFICIAL_LOCK_URL =
  "https://raw.githubusercontent.com/pragma-sh/pragma/main/packages/plugin-registry/official.lock.json";

/** A blocked or captive network must not leave onboarding waiting forever. */
const OFFICIAL_LOCK_TIMEOUT_MS = 5_000;

interface PluginLock {
  schemaVersion: 1;
  plugins: LockedPlugin[];
}

let cachedLock: Promise<LockedPlugin[]> | null = null;

/** Returns reviewed release metadata bundled with this app, without network I/O. */
export function bundledOfficialPluginLock(): LockedPlugin[] {
  return validateLock(officialPluginLock);
}

/**
 * Loads the official GitHub lock once, with the checked-in release metadata as an
 * offline fallback. The fetch is bounded: onboarding renders its list from this
 * promise, so a request that never settles leaves the agent step empty forever.
 */
export function loadOfficialPluginLock(): Promise<LockedPlugin[]> {
  cachedLock ??= fetchOfficialLock()
    .then((lock) => validateLock(lock))
    .catch(() => bundledOfficialPluginLock());
  return cachedLock;
}

async function fetchOfficialLock(): Promise<PluginLock> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFICIAL_LOCK_TIMEOUT_MS);
  try {
    const response = await fetch(OFFICIAL_LOCK_URL, {
      signal: controller.signal,
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`official plugin lock returned ${response.status}`);
    return (await response.json()) as PluginLock;
  } finally {
    clearTimeout(timer);
  }
}

/** Installs exact release represented by one validated lock entry. */
export async function installLockedPlugin(plugin: LockedPlugin): Promise<void> {
  await installOfficialPlugin({
    package: plugin.package,
    version: plugin.version,
    integrity: plugin.integrity,
    manifestSha256: plugin.manifestSha256,
  });
  window.dispatchEvent(new Event("pragma:config-changed"));
}

/** Human-readable install command shown before native execution. */
export function displayInstallCommand(plugin: LockedPlugin): string {
  return [plugin.manifest.install.command, ...(plugin.manifest.install.args ?? [])]
    .map(quoteArgument)
    .join(" ");
}

function quoteArgument(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function validateLock(lock: PluginLock): LockedPlugin[] {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.plugins)) {
    throw new Error("unsupported official plugin lock");
  }
  const packages = new Set<string>();
  return lock.plugins.filter((plugin) => {
    if (
      packages.has(plugin.package) ||
      !plugin.integrity.startsWith("sha512-") ||
      !/^[a-f0-9]{64}$/.test(plugin.manifestSha256) ||
      !plugin.manifest.install?.command
    ) {
      return false;
    }
    packages.add(plugin.package);
    return true;
  });
}
