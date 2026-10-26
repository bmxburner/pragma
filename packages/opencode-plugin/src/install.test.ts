import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };

const SCRIPT = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
const PINNED = `${packageJson.name}@${packageJson.version}`;
const V2_ENTRY = fileURLToPath(new URL("../dist/v2", import.meta.url));

type Config = { plugin?: unknown[]; plugins?: unknown[] };

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs the installer for one OpenCode plugin API against a temp config and returns it. */
function installConfig(api: "v1" | "v2", existing?: Record<string, unknown>): Config {
  dir = mkdtempSync(join(tmpdir(), "pragma-opencode-install-"));
  const configPath = join(dir, "opencode.json");
  if (existing) writeFileSync(configPath, JSON.stringify(existing));
  execFileSync("node", [SCRIPT], {
    env: { ...process.env, OPENCODE_CONFIG: configPath, PRAGMA_OPENCODE_PLUGIN_API: api },
  });
  return JSON.parse(readFileSync(configPath, "utf8")) as Config;
}

/** Runs the v1 installer and returns its `plugin` array. */
function install(existing?: Record<string, unknown>): unknown[] | undefined {
  return installConfig("v1", existing).plugin;
}

describe("install script", () => {
  it("registers the exact version being installed", () => {
    expect(install()).toEqual([PINNED]);
  });

  it("replaces an unpinned or older entry and keeps other plugins", () => {
    const plugins = install({
      plugin: ["other-plugin", packageJson.name, `${packageJson.name}@0.1.0-alpha.0`],
    });
    expect(plugins).toEqual(["other-plugin", PINNED]);
  });

  it("registers the v2 bundle under `plugins` for OpenCode v2", () => {
    expect(installConfig("v2")).toEqual({ plugins: [V2_ENTRY] });
  });

  it("moves an existing v1 entry over to v2 and keeps other plugins", () => {
    const config = installConfig("v2", {
      plugin: ["other-plugin", PINNED],
      plugins: [{ package: "/old/opencode-plugin/dist/v2" }, "v2-only"],
    });
    expect(config).toEqual({ plugin: ["other-plugin"], plugins: ["v2-only", V2_ENTRY] });
  });

  it("drops a stale v2 entry when installing for v1", () => {
    const config = installConfig("v1", { plugins: ["/old/opencode-plugin/dist/v2/index.mjs"] });
    expect(config).toEqual({ plugin: [PINNED] });
  });
});
