import { useSyncExternalStore } from "react";

import type {
  ComputerActivityEvent,
  ComputerActivitySnapshot,
  ComputerApproval,
  ComputerPoint,
  ComputerSession,
} from "@pragma-sh/constants";

import { computerRpc, onComputerActivity, type ComputerActivityMessage } from "@/lib/tauri";

/**
 * The desktop's live view of computer use on this machine: who is in control
 * of what, pending approvals, the helper's health, and where each session's
 * agent cursor last pointed.
 *
 * It mirrors the host's `computerActivity` stream (snapshot, then deltas)
 * through one Tauri event every window receives, so the main window, each
 * picture-in-picture window, and the cursor overlays all read the same state.
 * The reducer is pure (`applyComputerMessage`) and the store is a module
 * singleton read through `useSyncExternalStore`.
 */

/** Where a session's agent cursor is, and what it was doing there. */
export interface ComputerCursor {
  point: ComputerPoint;
  displayId: string | null;
  description: string | null;
  /** When the cursor started moving there (ms since epoch). */
  at: number;
  /** Increments on every completed action, to replay the click ripple. */
  pulses: number;
  physical: boolean;
}

/** The whole mirrored state. */
export interface ComputerUseState {
  snapshot: ComputerActivitySnapshot | null;
  cursors: Readonly<Record<string, ComputerCursor>>;
}

/** The state before the first snapshot arrives. */
export const INITIAL_COMPUTER_USE: ComputerUseState = { snapshot: null, cursors: {} };

function upsertSession(sessions: ComputerSession[], session: ComputerSession): ComputerSession[] {
  const index = sessions.findIndex((existing) => existing.id === session.id);
  if (index === -1) return [...sessions, session];
  const next = sessions.slice();
  next[index] = session;
  return next;
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

// fallow-ignore-next-line complexity -- one branch per activity type, each a small immutable update.
function applyDelta(state: ComputerUseState, event: ComputerActivityEvent): ComputerUseState {
  const snapshot = state.snapshot;
  if (!snapshot) return state;
  const base: ComputerActivitySnapshot = {
    ...snapshot,
    lastSeq: Math.max(snapshot.lastSeq, event.seq),
  };
  switch (event.type) {
    case "sessionStarted":
    case "sessionPaused":
    case "sessionResumed":
    case "actionCompleted": {
      const sessions = event.session ? upsertSession(base.sessions, event.session) : base.sessions;
      const cursors =
        event.type === "actionCompleted" && event.sessionId && state.cursors[event.sessionId]
          ? {
              ...state.cursors,
              [event.sessionId]: {
                ...state.cursors[event.sessionId]!,
                pulses: state.cursors[event.sessionId]!.pulses + 1,
                physical: event.physicalCursor ?? false,
              },
            }
          : state.cursors;
      return { snapshot: { ...base, sessions }, cursors };
    }
    case "sessionEnded": {
      const id = event.sessionId ?? event.session?.id;
      if (!id) return { ...state, snapshot: base };
      return {
        snapshot: { ...base, sessions: base.sessions.filter((session) => session.id !== id) },
        cursors: withoutKey(state.cursors, id),
      };
    }
    case "actionStarted": {
      if (!event.sessionId || !event.pointer) return { ...state, snapshot: base };
      const previous = state.cursors[event.sessionId];
      return {
        snapshot: base,
        cursors: {
          ...state.cursors,
          [event.sessionId]: {
            point: event.pointer.to,
            displayId: event.pointer.displayId ?? null,
            description: event.description ?? null,
            at: event.at,
            pulses: previous?.pulses ?? 0,
            physical: previous?.physical ?? false,
          },
        },
      };
    }
    case "approvalRequested": {
      const approval = event.approval;
      if (!approval || base.approvals.some((existing) => existing.id === approval.id)) {
        return { ...state, snapshot: base };
      }
      return { ...state, snapshot: { ...base, approvals: [...base.approvals, approval] } };
    }
    case "approvalResolved": {
      const id = event.approval?.id;
      return {
        ...state,
        snapshot: { ...base, approvals: base.approvals.filter((approval) => approval.id !== id) },
      };
    }
    case "helperState":
      return { ...state, snapshot: event.helper ? { ...base, helper: event.helper } : base };
    case "stopped":
      return { snapshot: { ...base, stopped: true, sessions: [], approvals: [] }, cursors: {} };
    default:
      return { ...state, snapshot: base };
  }
}

/** Applies one bridge message. Pure; exported for tests. */
export function applyComputerMessage(
  state: ComputerUseState,
  message: ComputerActivityMessage,
): ComputerUseState {
  if (message.kind === "snapshot") {
    const live = new Set(message.payload.sessions.map((session) => session.id));
    const cursors = Object.fromEntries(
      Object.entries(state.cursors).filter(([id]) => live.has(id)),
    );
    return { snapshot: message.payload, cursors };
  }
  return applyDelta(state, message.payload);
}

let state: ComputerUseState = INITIAL_COMPUTER_USE;
const listeners = new Set<() => void>();
let started: Promise<void> | null = null;

function setState(next: ComputerUseState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-reads the whole picture from the host (after the user unpauses, say). */
export async function refreshComputerUse(): Promise<void> {
  try {
    const snapshot = await computerRpc<ComputerActivitySnapshot>({ op: "status" });
    setState(applyComputerMessage(state, { kind: "snapshot", payload: snapshot }));
  } catch {
    // The host may still be starting; the bridge's snapshot will arrive.
  }
}

/** Starts mirroring the activity stream in this window (idempotent). */
export function startComputerUseBridge(): Promise<void> {
  started ??= onComputerActivity((message) => setState(applyComputerMessage(state, message))).then(
    () => refreshComputerUse(),
  );
  return started;
}

/** The mirrored state; starts the bridge on first use. */
export function useComputerUse(): ComputerUseState {
  void startComputerUseBridge();
  return useSyncExternalStore(subscribe, () => state);
}

/** Sessions in a worktree. Sessions with no worktree (scripts) belong to none. */
export function sessionsForWorktree(
  snapshot: ComputerActivitySnapshot | null,
  worktreeId: string,
): ComputerSession[] {
  return snapshot?.sessions.filter((session) => session.worktreeId === worktreeId) ?? [];
}

/** The apps a session holds, as a short phrase ("Safari and Notes"). */
export function controlledApps(session: ComputerSession): string {
  const names = [...new Set(session.leases.map((lease) => lease.appName))];
  if (names.length === 0) return "your computer";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/** Answers an approval prompt as the desktop user. */
export function answerApproval(
  approval: ComputerApproval,
  decision: "once" | "session" | "always" | "deny",
): Promise<void> {
  return computerRpc({ op: "approve", approval: approval.id, decision });
}

/** Pauses, resumes, or stops one session (or all of them with no id). */
export async function controlSession(
  op: "pause" | "unpause" | "stop",
  sessionId?: string,
): Promise<void> {
  await computerRpc(sessionId ? { op, session: sessionId } : { op });
  // `unpause` clears the stop latch, which emits no event of its own.
  if (op === "unpause") await refreshComputerUse();
}
