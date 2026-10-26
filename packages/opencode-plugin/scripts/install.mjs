import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// OpenCode v1 and v2 load different plugin implementations from different
// config keys, and a v1 plugin never runs under v2. Select the implementation
// for the OpenCode that is installed; PRAGMA_OPENCODE_PLUGIN_API=v1|v2 forces it.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const api = selectApi();

// v1: pin the exact release being installed. OpenCode caches a bare package
// name once and never re-resolves it, so an unpinned entry keeps loading
// whichever version it first fetched after every Pragma upgrade.
// v2: the package root is the v1 entry, so register the v2 bundle by path. v2
// only loads a path that is a package directory, so this is `dist/v2` (whose
// manifest the build writes), not the `.mjs` file. It lives in this install's
// own directory, which Pragma keeps until it replaces it with a newer release —
// and that release re-runs this script.
const entry =
  api === "v2" ? join(packageRoot, "dist", "v2") : `${packageJson.name}@${packageJson.version}`;

const configPath =
  process.env.OPENCODE_CONFIG ?? join(homedir(), ".config", "opencode", "opencode.json");
let config = {};
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw new Error(
      `${configPath} must be valid JSON before Pragma can install its OpenCode plugin`,
      { cause: error },
    );
  }
}

// v1 reads `plugin`; v2 reads `plugins`. Our entry goes in exactly one of them,
// and every earlier entry of ours (either API, pinned or by path) is replaced.
const [ownKey, otherKey] = api === "v2" ? ["plugins", "plugin"] : ["plugin", "plugins"];
const next = { ...config, [ownKey]: [...withoutOurs(config[ownKey]), entry] };
const remaining = withoutOurs(config[otherKey]);
if (remaining.length > 0) {
  next[otherKey] = remaining;
} else {
  delete next[otherKey];
}
await mkdir(dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });

function selectApi() {
  const forced = process.env.PRAGMA_OPENCODE_PLUGIN_API?.trim().toLowerCase();
  if (forced === "v1" || forced === "v2") return forced;
  return opencodeMajorVersion() >= 2 ? "v2" : "v1";
}

/** Major version of the `opencode` on PATH, or 0 when it is missing or unreadable. */
function opencodeMajorVersion() {
  try {
    const output = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      // A global npm install is `opencode.cmd` on Windows, which needs a shell.
      shell: process.platform === "win32",
    });
    const match = /(\d+)\.\d+\.\d+/.exec(output);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** Plugin entries (strings or v2 `{ package }` objects) that are not this package. */
function withoutOurs(entries) {
  return (Array.isArray(entries) ? entries : []).filter((item) => !isOurs(item));
}

function isOurs(item) {
  const spec = typeof item === "string" ? item : item?.package;
  if (typeof spec !== "string") return false;
  if (spec === packageJson.name || spec.startsWith(`${packageJson.name}@`)) return true;
  // A path to one of this package's bundles: a Pragma install directory or a
  // local workspace build.
  const normalized = spec.replaceAll("\\", "/");
  return (
    normalized.includes("opencode-plugin") &&
    /\/dist\/(?:index\.mjs|v2(?:\/index\.mjs)?)\/?$/.test(normalized)
  );
}
