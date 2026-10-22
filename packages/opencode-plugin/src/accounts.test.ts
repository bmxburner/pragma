import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiKeyIdentity } from "@pragma-sh/plugin/catalog";
import { beforeEach, describe, expect, it } from "vitest";

import { credentialEntry, openCodeStoreAccount, type V2Credential } from "./accounts";
import { resetOpenCodeVersionCache } from "./opencode-version";

const STORE = { dirEnv: "XDG_DATA_HOME", defaultDir: "~/.local/share", file: "opencode/auth.json" };

/** A fake OpenCode v2 host: `--version`, and the credential REST surface. */
function fakeV2Host(initial: V2Credential[]) {
  const credentials = initial.map((credential) => ({ ...credential }));
  const calls: string[] = [];
  const run = async ({ commands }: { commands: string[] }) =>
    commands.map((command) => {
      calls.push(command);
      return { command, stderr: "", status: 0, durationMs: 0, stdout: respond(command) };
    });
  const routes: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    [/^opencode --version$/, () => "opencode v2.1.1\n"],
    [/GET '\/api\/credential'/, () => JSON.stringify({ data: credentials })],
    [/POST '\/api\/credential\/([^/']+)\/activate'/, (match) => activate(match[1])],
    [/PATCH '\/api\/credential\/([^']+)' -d '(.+)'$/, (match) => relabel(match[1], match[2])],
  ];
  function respond(command: string): string {
    for (const [pattern, handle] of routes) {
      const match = pattern.exec(command);
      if (match) return handle(match);
    }
    throw new Error(`unexpected command: ${command}`);
  }
  function activate(id: string | undefined): string {
    const target = credentials.find((credential) => credential.id === id);
    for (const credential of credentials) {
      if (credential.integrationID === target?.integrationID)
        credential.active = credential === target;
    }
    return "";
  }
  function relabel(id: string | undefined, body: string | undefined): string {
    const target = credentials.find((credential) => credential.id === id);
    if (target) target.label = (JSON.parse(body ?? "{}") as { label: string }).label;
    return "";
  }
  return { credentials, calls, sdk: { exec: { run } } };
}

function keyCredential(id: string, key: string, label: string, active: boolean): V2Credential {
  return { id, integrationID: "opencode-go", label, active, value: { type: "key", key } };
}

const provider = openCodeStoreAccount({
  provider: "opencode-go",
  agent: "opencode",
  store: STORE,
  entries: ["opencode-go"],
});

/** A Pragma login's home holding one pre-v2 `auth.json` entry for `opencode-go`. */
async function legacyHome(entry: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opencode-v1-login-"));
  await mkdir(join(home, "opencode"), { recursive: true });
  await writeFile(join(home, "opencode", "auth.json"), JSON.stringify({ "opencode-go": entry }));
  return home;
}

function accountCtx(
  host: ReturnType<typeof fakeV2Host>,
  account: { loginId: string; home: string | null },
) {
  return { project: { path: "/tmp" }, sdk: host.sdk, account: { ...account, env: {} } } as never;
}

beforeEach(() => {
  resetOpenCodeVersionCache();
});

describe("OpenCode v2 accounts", () => {
  it("identifies the harness's own sign-in as its unlabelled credential", async () => {
    const host = fakeV2Host([
      keyCredential("cred_pragma", "other-key", "pragma:login-1", false),
      keyCredential("cred_own", "own-key", "API key", true),
    ]);
    const identity = await provider.identify?.(
      accountCtx(host, { loginId: "default", home: null }),
    );
    expect(identity).toEqual(await apiKeyIdentity("own-key"));
  });

  it("activates the credential bound to a Pragma login", async () => {
    const host = fakeV2Host([
      keyCredential("cred_own", "own-key", "API key", true),
      keyCredential("cred_pragma", "other-key", "pragma:login-1", false),
    ]);
    await provider.swap?.activate(accountCtx(host, { loginId: "login-1", home: "/h/1" }));
    expect(host.calls).toContain("opencode api POST '/api/credential/cred_pragma/activate'");
    expect(host.credentials.find((credential) => credential.id === "cred_pragma")?.active).toBe(
      true,
    );
  });

  it("claims the credential a new login signs in to", async () => {
    const home = await mkdtemp(join(tmpdir(), "opencode-v2-login-"));
    const host = fakeV2Host([keyCredential("cred_own", "own-key", "API key", true)]);
    const ctx = accountCtx(host, { loginId: "login-2", home });

    // Before sign-in: nothing is bound yet, so only the existing ids are recorded.
    await provider.swap?.activate(ctx);
    expect(await provider.identify?.(ctx)).toBeNull();

    // `opencode auth login` adds and activates a credential of its own.
    host.credentials[0]!.active = false;
    host.credentials.push(keyCredential("cred_new", "new-key", "API key", true));

    expect(await provider.identify?.(ctx)).toEqual(await apiKeyIdentity("new-key"));
    expect(host.credentials.find((credential) => credential.id === "cred_new")?.label).toBe(
      "pragma:login-2",
    );
    // The harness's own sign-in is never claimed by the new login.
    expect(host.credentials.find((credential) => credential.id === "cred_own")?.label).toBe(
      "API key",
    );
  });

  it("binds a login saved before OpenCode 2 to the v2 copy of its key", async () => {
    const home = await legacyHome({ type: "api", key: "legacy-key" });
    const host = fakeV2Host([
      keyCredential("cred_own", "own-key", "API key", true),
      keyCredential("cred_legacy", "legacy-key", "API key", false),
    ]);
    const ctx = accountCtx(host, { loginId: "login-4", home });

    expect(await provider.identify?.(ctx)).toEqual(await apiKeyIdentity("legacy-key"));
    expect(host.credentials.find((credential) => credential.id === "cred_legacy")?.label).toBe(
      "pragma:login-4",
    );
  });

  it("asks a login saved before OpenCode 2 to sign in again rather than use another account", async () => {
    const home = await legacyHome({ type: "api", key: "gone-key" });
    const host = fakeV2Host([keyCredential("cred_own", "own-key", "API key", true)]);
    const ctx = accountCtx(host, { loginId: "login-5", home });

    await expect(provider.swap?.activate(ctx)).rejects.toThrow(/Sign in again/);
    expect(host.calls.some((command) => command.includes("/activate"))).toBe(false);
    expect(await provider.identify?.(ctx)).toBeNull();
  });

  it("lends a login's key but refuses to borrow one", async () => {
    const host = fakeV2Host([keyCredential("cred_pragma", "lent-key", "pragma:login-1", true)]);
    const ctx = accountCtx(host, { loginId: "login-1", home: "/h/1" });
    expect(await provider.sharedToken?.read(ctx)).toEqual({ type: "api", key: "lent-key" });
    await expect(
      provider.sharedToken?.write?.(ctx, { type: "api", key: "borrowed" }),
    ).rejects.toThrow(/cannot borrow/);
  });

  it("maps a v2 OAuth credential onto the auth.json entry shape", () => {
    expect(
      credentialEntry({
        id: "cred_1",
        integrationID: "openai",
        label: "OAuth",
        active: true,
        value: {
          type: "oauth",
          methodID: "chatgpt",
          access: "a",
          refresh: "r",
          expires: 5,
          metadata: { accountID: "acct" },
        },
      }),
    ).toEqual({ type: "oauth", access: "a", refresh: "r", expires: 5, accountId: "acct" });
  });
});
