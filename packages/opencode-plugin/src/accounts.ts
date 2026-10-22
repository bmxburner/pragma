import {
  credentialStoreAccount,
  entryToken,
  readCredentialFile,
  storedCredentialIdentity,
  writeCredentialFile,
  type AccountContext,
  type AccountIdentity,
  type AccountProviderDefinition,
  type CredentialStoreAccountOptions,
  type SharedToken,
} from "@pragma-sh/plugin/catalog";

import { openCodeApi, responseData } from "./opencode-api";
import { isOpenCodeV2 } from "./opencode-version";

/**
 * OpenCode v2 keeps every account in its own database (`opencode auth list`,
 * `opencode auth switch`), not in `auth.json`, and serves every OpenCode
 * process from one background service — so a per-login `XDG_DATA_HOME` no
 * longer separates accounts. On v2 a Pragma login is bound to one v2
 * credential, labelled {@link PRAGMA_LABEL_PREFIX}`<loginId>`, and switching
 * activates it. OpenCode refreshes its own credentials, so Pragma never copies
 * a rotating token.
 *
 * The harness's own sign-in (`home === null`) is the integration's credential
 * Pragma did not label.
 */
const PRAGMA_LABEL_PREFIX = "pragma:";

/** Snapshot left in a new login's home while it signs in, naming the credentials that predate it. */
const PENDING_FILE = "opencode/pragma-v2-pending.json";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** One OpenCode v2 credential, as `GET /api/credential` returns it. */
export interface V2Credential {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value: Record<string, unknown>;
}

/**
 * An OpenCode account provider for both OpenCode versions: v1 swaps its
 * entries in `auth.json` (`credentialStoreAccount`), v2 activates the
 * credential bound to the login. Each callback asks which version is installed.
 */
export function openCodeStoreAccount(
  options: CredentialStoreAccountOptions,
): AccountProviderDefinition {
  const v1 = credentialStoreAccount({ ...options, switchable: true });
  const v2 = v2Callbacks(options);
  const v1Swap = v1.swap;
  const v1Identify = v1.identify;
  return {
    ...v1,
    ...(v1Swap
      ? {
          swap: {
            activate: async (ctx) =>
              (await isOpenCodeV2(ctx)) ? v2.activate(ctx) : v1Swap.activate(ctx),
          },
        }
      : {}),
    ...(v1Identify
      ? {
          identify: async (ctx) => ((await isOpenCodeV2(ctx)) ? v2.identify(ctx) : v1Identify(ctx)),
        }
      : {}),
    ...(v1.sharedToken ? { sharedToken: dualSharedToken(v1.sharedToken, v2) } : {}),
  };
}

function dualSharedToken(
  v1: NonNullable<AccountProviderDefinition["sharedToken"]>,
  v2: ReturnType<typeof v2Callbacks>,
): NonNullable<AccountProviderDefinition["sharedToken"]> {
  const v1Write = v1.write;
  return {
    kind: v1.kind,
    read: async (ctx) => ((await isOpenCodeV2(ctx)) ? v2.read(ctx, v1.kind) : v1.read(ctx)),
    ...(v1Write
      ? {
          write: async (ctx, token) => {
            if (await isOpenCodeV2(ctx)) {
              // Creating a v2 credential sends its secret on the `opencode api`
              // command line, where other local users can read it.
              throw new Error(
                "OpenCode 2 cannot borrow a sign-in from another app yet; sign in through OpenCode instead.",
              );
            }
            await v1Write(ctx, token);
          },
        }
      : {}),
  };
}

function v2Callbacks(options: CredentialStoreAccountOptions) {
  const integrations = new Set(options.entries);
  const apiKeyOnly = options.apiKeyOnly ?? false;

  async function credentials(ctx: AccountContext): Promise<V2Credential[]> {
    const listed = responseData(await openCodeApi(ctx, "GET", "/api/credential"));
    return parseV2Credentials(listed).filter(
      (credential) =>
        integrations.has(credential.integrationID) &&
        !(apiKeyOnly && credential.value.type === "oauth"),
    );
  }

  /** The credential a login is bound to, claiming the one a new login just created. */
  async function bound(ctx: AccountContext): Promise<V2Credential | null> {
    const all = await credentials(ctx);
    if (ctx.account.home === null) return harnessCredential(all);
    const label = loginLabel(ctx.account.loginId);
    return all.find((credential) => credential.label === label) ?? (await claimNew(ctx, all));
  }

  /** Labels the credential created since this login started signing in. */
  async function claimNew(ctx: AccountContext, all: V2Credential[]): Promise<V2Credential | null> {
    const home = ctx.account.home;
    if (home === null) return null;
    const pending = await readCredentialFile(`${home}/${PENDING_FILE}`);
    const known = Array.isArray(pending?.known) ? new Set(pending.known) : null;
    if (!known) return null;
    const created = all.find(
      (credential) =>
        credential.active && !known.has(credential.id) && !isPragmaLabel(credential.label),
    );
    if (!created) return null;
    const label = loginLabel(ctx.account.loginId);
    await openCodeApi(ctx, "PATCH", `/api/credential/${safeId(created.id)}`, { label });
    await writeCredentialFile(`${home}/${PENDING_FILE}`, {});
    return { ...created, label };
  }

  return {
    async activate(ctx: AccountContext): Promise<void> {
      const credential = await bound(ctx);
      if (credential) {
        if (!credential.active) {
          await openCodeApi(ctx, "POST", `/api/credential/${safeId(credential.id)}/activate`);
        }
        return;
      }
      // A new login about to sign in: OpenCode adds and activates the new
      // credential itself; remember what existed so `identify` can claim it.
      const home = ctx.account.home;
      if (home !== null) {
        const all = await credentials(ctx);
        await writeCredentialFile(`${home}/${PENDING_FILE}`, {
          known: all.map((entry) => entry.id),
        });
      }
    },
    async identify(ctx: AccountContext): Promise<AccountIdentity | null> {
      const credential = await bound(ctx);
      return credential
        ? storedCredentialIdentity(options.provider, credentialEntry(credential))
        : null;
    },
    async read(ctx: AccountContext, kind: string): Promise<SharedToken | null> {
      const credential = await bound(ctx);
      const type = kind.startsWith("key:") ? "api" : "oauth";
      return credential ? entryToken(credentialEntry(credential), type) : null;
    },
  };
}

/** Parses `GET /api/credential` data, dropping entries it does not recognize. */
function parseV2Credentials(data: unknown): V2Credential[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const entry = item as Record<string, unknown>;
    const value = entry.value;
    if (
      typeof entry.id !== "string" ||
      typeof entry.integrationID !== "string" ||
      typeof value !== "object" ||
      value === null
    ) {
      return [];
    }
    return [
      {
        id: entry.id,
        integrationID: entry.integrationID,
        label: typeof entry.label === "string" ? entry.label : "",
        active: entry.active === true,
        value: value as Record<string, unknown>,
      },
    ];
  });
}

/**
 * A v2 credential value in the `auth.json` entry shape Pragma's identity and
 * token helpers read: `{ type: "api", key }` or `{ type: "oauth", … }`.
 */
export function credentialEntry(credential: V2Credential): Record<string, unknown> {
  const value = credential.value;
  if (value.type === "key") return { type: "api", key: value.key };
  if (value.type !== "oauth") return {};
  const metadata =
    typeof value.metadata === "object" && value.metadata !== null
      ? (value.metadata as Record<string, unknown>)
      : {};
  return {
    type: "oauth",
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(typeof metadata.accountID === "string" ? { accountId: metadata.accountID } : {}),
  };
}

/** The harness's own sign-in: the active unlabelled credential, else any unlabelled one. */
function harnessCredential(all: V2Credential[]): V2Credential | null {
  const own = all.filter((credential) => !isPragmaLabel(credential.label));
  return own.find((credential) => credential.active) ?? own[0] ?? null;
}

function isPragmaLabel(label: string): boolean {
  return label.startsWith(PRAGMA_LABEL_PREFIX);
}

function loginLabel(loginId: string): string {
  return `${PRAGMA_LABEL_PREFIX}${safeId(loginId)}`;
}

/** Ids are interpolated into a URL path and a shell command, so only plain ones pass. */
function safeId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`unexpected OpenCode id: ${id}`);
  return id;
}
