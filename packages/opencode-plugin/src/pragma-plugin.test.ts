import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resetOpenCodeVersionCache } from "./opencode-version";
import {
  OPENCODE_API_KEY_PROVIDERS,
  opencodeAgentPlugin,
  parseOpenCodeModels,
} from "./pragma-plugin";

const sourceDir = dirname(fileURLToPath(import.meta.url));

/** Modules bundled into `dist/pragma-plugin.mjs`, the entry the webview imports. */
const ENTRY_MODULES = [
  "pragma-plugin.ts",
  "usage-limits.ts",
  "cwd.ts",
  "accounts.ts",
  "host-shell.ts",
  "opencode-api.ts",
  "opencode-version.ts",
];

describe("opencode plugin entry", () => {
  it("contributes the launchable OpenCode agent", () => {
    expect(opencodeAgentPlugin.agents?.map((agent) => agent.id)).toEqual(["opencode"]);
  });

  // The desktop webview evaluates this bundle as a blob module, where a static
  // `node:` import fails to resolve and a module-scope `process` read throws —
  // either one drops the whole plugin and its agents vanish from the launcher
  // while the Bun sidecars keep listing them. Keep node-only work lazy.
  it.each(ENTRY_MODULES)("keeps %s free of module-scope node globals", (file) => {
    const source = readFileSync(join(sourceDir, file), "utf8");
    expect(source).not.toMatch(/^import .*"node:/m);
    expect(source).not.toMatch(/^\s*(?:const|let|var) .*\bprocess\./m);
  });
});

it("keeps a version dot in a derived model name", () => {
  expect(
    parseOpenCodeModels(
      ["opencode/claude-opus-4-5", "opencode/gemini-3.1-pro", "opencode/big-pickle"].join("\n"),
    ),
  ).toEqual([
    { id: "opencode/claude-opus-4-5", name: "claude opus 4.5 (opencode)" },
    { id: "opencode/gemini-3.1-pro", name: "gemini 3.1 pro (opencode)" },
    { id: "opencode/big-pickle", name: "big pickle (opencode)" },
  ]);
});

function byProvider(provider: string) {
  return opencodeAgentPlugin.accounts?.find((candidate) => candidate.provider === provider);
}

describe("opencode account providers", () => {
  it("signs in to OpenCode Go, OpenAI, GitHub Copilot, and API-key providers", () => {
    expect(opencodeAgentPlugin.accounts?.map((provider) => provider.provider)).toEqual([
      "opencode-go",
      "openai",
      "github-copilot",
      ...OPENCODE_API_KEY_PROVIDERS.map((entry) => entry.provider),
    ]);
    for (const provider of opencodeAgentPlugin.accounts ?? []) {
      expect(provider.agent).toBe("opencode");
      expect(provider.identify).toBeTypeOf("function");
    }
  });

  // OpenCode v2 serves every process from one background service, so a data
  // directory no longer selects an account: every provider switches instead.
  it("switches every provider in place instead of giving it a data directory", () => {
    for (const provider of opencodeAgentPlugin.accounts ?? []) {
      expect(provider.env).toBeUndefined();
      expect(provider.swap?.activate).toBeTypeOf("function");
    }
    expect(byProvider("opencode-go")?.usageLimits?.primaryLimitId).toBe("rolling");
  });

  // v1 preselects with `--provider`, v2 with a positional target, and each
  // rejects the other's form; both open a picker when given neither.
  it("signs in with the provider picker both OpenCode versions accept", () => {
    for (const provider of opencodeAgentPlugin.accounts ?? []) {
      expect(provider.login?.command).toEqual(["opencode", "auth", "login"]);
    }
    expect(byProvider("openrouter")?.login?.instructions).toContain("Pick OpenRouter");
    expect(byProvider("anthropic")?.login?.instructions).toContain("Anthropic API key");
    expect(byProvider("openai")?.login?.instructions).toContain("ChatGPT Pro/Plus (browser)");
  });

  // Claude Free/Pro/Max OAuth may only be used in Claude Code and claude.ai.
  it("never identifies a Claude subscription sign-in", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "opencode-accounts-"));
    await mkdir(join(dir, "opencode"));
    await writeFile(
      join(dir, "opencode", "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r" } }),
    );
    resetOpenCodeVersionCache();
    const ctx = {
      account: { loginId: "x", home: dir, env: {} },
      project: { path: dir },
      sdk: {
        exec: {
          run: async () => [
            { command: "", stdout: "1.19.3\n", stderr: "", status: 0, durationMs: 0 },
          ],
        },
      },
    };
    expect(await byProvider("anthropic")?.identify?.(ctx as never)).toBeNull();
  });

  it("leaves the shared providers' icon to their own harness", () => {
    expect(byProvider("openai")?.iconPath).toBeUndefined();
    expect(byProvider("github-copilot")?.iconPath).toBeUndefined();
  });
});
