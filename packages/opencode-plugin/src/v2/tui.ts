// The `tui/plugin` subpath is the bare `define` helper; the `tui` root also
// re-exports Solid components, which would drag the renderer into this bundle.
import { type Context, type Definition, define } from "@opencode/plugin/tui/plugin";

import { type PragmaReporterOptions, createSdkReporter } from "../reporter";
import { PRAGMA_OPENCODE_V2_PLUGIN_ID } from "./id";
import { type RuntimeEvent, type V2Event, runtimeEventsFromV2 } from "./events";
import { type SessionStatuses, createSessionStatuses } from "./session-statuses";

type LegacyHooks = ReturnType<SessionStatuses["hooksFor"]>;
type ChatMessageInput = Parameters<NonNullable<LegacyHooks["chat.message"]>>;

/** A v2 event as the TUI's event feed delivers it. */
type TuiEvent = V2Event;

/** Whom an event is for: one root session's status, or every session (service-wide). */
export type EventOwner = { kind: "root"; root: string } | { kind: "service" };

/** Decides which events belong to this TUI, and which root sessions it still shows. */
export interface SessionScope {
  /** The owner of an event, or `undefined` when this TUI does not show its session. */
  ownerOf(event: TuiEvent): EventOwner | undefined;
  /** Whether this TUI still shows a root session, as its routed session or an open tab. */
  shown(root: string): boolean;
}

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
    const statuses = createSessionStatuses(reporter);
    const scope = createSessionScope(ctx);
    // `listen` is synchronous; chain handling so event order is preserved and
    // a reply can never overtake the prompt it answers.
    let queue = Promise.resolve();
    const stop = ctx.data.listen(({ details }) => {
      const event = details as unknown as TuiEvent;
      queue = queue.then(() => handleEvent(event, scope, statuses)).catch(warn);
    });

    return async () => {
      stop();
      await queue;
      await statuses.dispose();
    };
  },
});

export default PragmaOpencodeTuiPlugin;

/**
 * Feeds one v2 event through its root session's state machine. Sessions this
 * TUI no longer shows are released first, so their status leaves the tab with
 * them.
 */
export async function handleEvent(
  event: TuiEvent,
  scope: SessionScope,
  statuses: SessionStatuses,
): Promise<void> {
  const owner = scope.ownerOf(event);
  await statuses.release(scope.shown);
  if (!owner) {
    return;
  }
  const runtimeEvents = runtimeEventsFromV2(event);
  if (owner.kind === "service") {
    for (const hooks of statuses.all()) {
      // oxlint-disable-next-line no-await-in-loop -- each root's state machine takes the event in turn.
      await feedRuntimeEvents(hooks, runtimeEvents);
    }
    return;
  }
  await feedRoot(statuses.hooksFor(owner.root), event, runtimeEvents);
}

async function feedRoot(
  hooks: LegacyHooks,
  event: TuiEvent,
  runtimeEvents: RuntimeEvent[],
): Promise<void> {
  const prompt = userPrompt(event);
  if (!prompt) {
    await feedRuntimeEvents(hooks, runtimeEvents);
    return;
  }
  // v2 has no `chat.message` hook on the TUI side; a queued user message is
  // the prompt the state machine needs to mark the turn busy and transcribe.
  await hooks["chat.message"]?.(
    { sessionID: prompt.sessionID } as ChatMessageInput[0],
    {
      message: {},
      parts: [{ type: "text", text: prompt.text }],
    } as unknown as ChatMessageInput[1],
  );
}

async function feedRuntimeEvents(hooks: LegacyHooks, runtimeEvents: RuntimeEvent[]): Promise<void> {
  for (const runtimeEvent of runtimeEvents) {
    // oxlint-disable-next-line no-await-in-loop -- event order is the state machine's input.
    await hooks.event?.({ event: runtimeEvent as never });
  }
}

/**
 * Decides which events belong to this TUI. One background service serves every
 * OpenCode TUI on the machine and the TUI's event feed is not limited to its
 * own sessions, so without this scope one tab would report another tab's
 * agent. A root session is this TUI's while it is the routed session or one of
 * its open session tabs, checked on every event so a session the TUI has moved
 * away from stops reporting here; children follow their root.
 */
export function createSessionScope(ctx: Context): SessionScope {
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

  return {
    shown,
    ownerOf(event) {
      const data = isRecord(event.data) ? event.data : {};
      const sessionID = eventSessionId(data);
      if (!sessionID) {
        // Only service-wide lifecycle events carry no session (`global.disposed`).
        return { kind: "service" };
      }
      const parentID = typeof data.parentID === "string" ? data.parentID : undefined;
      const root = rootOf(parentID ?? sessionID);
      if (parentID) {
        childRoots.set(sessionID, root);
      }
      return shown(root) ? { kind: "root", root } : undefined;
    },
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
