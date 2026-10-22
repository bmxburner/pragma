// The `tui/plugin` subpath is the bare `define` helper; the `tui` root also
// re-exports Solid components, which would drag the renderer into this bundle.
import { type Context, type Definition, define } from "@opencode/plugin/tui/plugin";

import { createPragmaOpencodeHooks } from "../hooks";
import { type PragmaReporterOptions, createSdkReporter } from "../reporter";
import { PRAGMA_OPENCODE_V2_PLUGIN_ID } from "./id";
import { type V2Event, runtimeEventsFromV2 } from "./events";

type LegacyHooks = ReturnType<typeof createPragmaOpencodeHooks>;
type ChatMessageInput = Parameters<NonNullable<LegacyHooks["chat.message"]>>;

/** A v2 event as the TUI's event feed delivers it. */
type TuiEvent = V2Event;

/**
 * Pragma's OpenCode v2 status reporter. It runs in the **TUI** process, not the
 * server: v2 server plugins load inside the shared `opencode serve --service`
 * daemon, which outlives every tab and never has a tab's `PRAGMA_*` env, so a
 * server-side reporter could only drop its reports (or send them to whichever
 * tab first started the service). The TUI is the process Pragma launched in the
 * tab, so its env names the right tab and worktree.
 */
export const PragmaOpencodeTuiPlugin: Definition = define({
  id: PRAGMA_OPENCODE_V2_PLUGIN_ID,
  setup(ctx: Context) {
    const reporter = createSdkReporter(ctx.options as PragmaReporterOptions);
    // A previous run in this tab may have died without cleanup; see `../index.ts`.
    void reporter.cleared();
    const hooks = createPragmaOpencodeHooks(reporter);
    const owns = createSessionScope(ctx);
    // `listen` is synchronous; chain handling so event order is preserved and
    // a reply can never overtake the prompt it answers.
    let queue = Promise.resolve();
    const stop = ctx.data.listen(({ details }) => {
      const event = details as unknown as TuiEvent;
      queue = queue.then(() => handleEvent(event, hooks, owns)).catch(warn);
    });

    return async () => {
      stop();
      await queue;
      // The TUI is exiting: clear the indicator, as v1's `dispose` does.
      await hooks.dispose?.();
    };
  },
});

export default PragmaOpencodeTuiPlugin;

/** Feeds one v2 event through the shared state machine when it belongs to this TUI. */
export async function handleEvent(
  event: TuiEvent,
  hooks: LegacyHooks,
  owns: (event: TuiEvent) => boolean,
): Promise<void> {
  if (!owns(event)) {
    return;
  }
  const prompt = userPrompt(event);
  if (prompt) {
    // v2 has no `chat.message` hook on the TUI side; a queued user message is
    // the prompt the state machine needs to mark the turn busy and transcribe.
    await hooks["chat.message"]?.(
      { sessionID: prompt.sessionID } as ChatMessageInput[0],
      {
        message: {},
        parts: [{ type: "text", text: prompt.text }],
      } as unknown as ChatMessageInput[1],
    );
    return;
  }
  for (const runtimeEvent of runtimeEventsFromV2(event)) {
    // oxlint-disable-next-line no-await-in-loop -- event order is the state machine's input.
    await hooks.event?.({ event: runtimeEvent as never });
  }
}

/**
 * Decides which events belong to this TUI. One background service serves every
 * OpenCode TUI on the machine and the TUI's event feed is not limited to its
 * own sessions, so without this scope one tab would report another tab's
 * agent. A root session is this TUI's once it is the routed session or one of
 * its open session tabs; children follow their root.
 */
export function createSessionScope(ctx: Context): (event: TuiEvent) => boolean {
  const owned = new Set<string>();
  /** Child → root, from `session.created`: the TUI's store may not hold a new child yet. */
  const childRoots = new Map<string, string>();

  const rootOf = (sessionID: string): string => {
    const known = childRoots.get(sessionID);
    if (known) {
      return known;
    }
    try {
      return ctx.data.session.root(sessionID) || sessionID;
    } catch {
      return sessionID;
    }
  };

  const shown = (root: string): boolean => {
    const route = ctx.ui.router.current();
    if (route.type === "session" && rootOf(route.sessionID) === root) {
      return true;
    }
    return ctx.ui.tabs.enabled() && ctx.ui.tabs.list().some((tab) => tab.sessionID === root);
  };

  return (event) => {
    const data = isRecord(event.data) ? event.data : {};
    const sessionID = eventSessionId(data);
    if (!sessionID) {
      // Only service-wide lifecycle events carry no session (`global.disposed`).
      return true;
    }
    const parentID = typeof data.parentID === "string" ? data.parentID : undefined;
    const root = rootOf(parentID ?? sessionID);
    if (parentID) {
      childRoots.set(sessionID, root);
    }
    if (owned.has(root)) {
      return true;
    }
    if (shown(root)) {
      owned.add(root);
      return true;
    }
    return false;
  };
}

function eventSessionId(data: Record<string, unknown>): string | undefined {
  if (typeof data.sessionID === "string") {
    return data.sessionID;
  }
  // `form.created` nests its session under the form.
  const form = isRecord(data.form) ? data.form : undefined;
  return typeof form?.sessionID === "string" ? form.sessionID : undefined;
}

function userPrompt(event: TuiEvent): { sessionID: string; text: string } | undefined {
  if (event.type !== "session.inbox.enqueued" || !isRecord(event.data)) {
    return undefined;
  }
  const { sessionID, item } = event.data;
  if (typeof sessionID !== "string" || !isRecord(item) || item.type !== "user") {
    return undefined;
  }
  const payload = isRecord(item.payload) ? item.payload : {};
  return { sessionID, text: typeof payload.text === "string" ? payload.text : "" };
}

function warn(error: unknown): void {
  if (process.env.PRAGMA_OPENCODE_PLUGIN_DEBUG === "1") {
    console.warn("@pragma-sh/opencode-plugin v2 event handling failed", error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
