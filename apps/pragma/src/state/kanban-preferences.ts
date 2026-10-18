import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { BoardPreferences } from "@/lib/kanban-model";
import { readKanbanPreferences, writeKanbanPreferences } from "@/lib/tauri";

const EMPTY: BoardPreferences = {
  categories: [],
  assignments: {},
  attempts: {},
  overrides: {},
  dismissedSuggestions: [],
};
const listeners = new Set<() => void>();
let preferences: Record<string, BoardPreferences> = {};
const loads = new Map<string, Promise<void>>();
let writes: Promise<void> = Promise.resolve();

function notifySubscribers(): void {
  for (const listener of listeners) listener();
}

async function readProjectPreferences(projectId: string): Promise<void> {
  let raw: string | null;
  try {
    raw = await readKanbanPreferences(projectId);
  } catch (cause) {
    loads.delete(projectId);
    throw cause;
  }
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    /* Malformed legacy metadata falls back to an empty board configuration. */
  }
  // Older documents predate `dismissedSuggestions`; EMPTY backfills any missing field.
  preferences = {
    ...preferences,
    [projectId]: isPreferences(value) ? { ...EMPTY, ...value } : EMPTY,
  };
  notifySubscribers();
}

function load(projectId: string): Promise<void> {
  const existing = loads.get(projectId);
  if (existing) return existing;
  const pending = readProjectPreferences(projectId);
  loads.set(projectId, pending);
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A stored document may predate `dismissedSuggestions`; the field is optional here. */
type StoredPreferences = Omit<BoardPreferences, "dismissedSuggestions"> & {
  dismissedSuggestions?: string[];
};

const HEX_COLOR = /^#[\da-f]{6}$/i;
const OVERRIDE_STATUSES = new Set<unknown>(["completed", "inProgress", "reviewNeeded"]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): boolean {
  return value === null || isString(value);
}

function isCategory(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.color) &&
    HEX_COLOR.test(value.color)
  );
}

function isAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.key) &&
    isString(value.selector) &&
    isNullableString(value.modelId) &&
    isNullableString(value.reasoningId)
  );
}

function isArrayOf(value: unknown, item: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(item);
}

function isRecordOf(value: unknown, item: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(item);
}

function isPreferences(value: unknown): value is StoredPreferences {
  return (
    isRecord(value) &&
    isArrayOf(value.categories, isCategory) &&
    isRecordOf(value.assignments, isString) &&
    isRecordOf(value.overrides, (status) => OVERRIDE_STATUSES.has(status)) &&
    isRecordOf(value.attempts, (attempts) => isArrayOf(attempts, isAttempt)) &&
    isArrayOf(value.dismissedSuggestions ?? [], isString)
  );
}

/** Subscribes to a project's board presentation and manual workflow choices. */
export function useBoardPreferences(projectId: string | null): BoardPreferences {
  useEffect(() => {
    if (projectId)
      void load(projectId).catch((cause) =>
        toast.error(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [projectId]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (projectId ? (preferences[projectId] ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

/** Prevents editing a saved draft before its persisted attempt selectors have loaded. */
export function useBoardPreferencesLoading(projectId: string | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => Boolean(projectId && !preferences[projectId]),
    () => true,
  );
}

async function mutate(
  projectId: string,
  update: (current: BoardPreferences) => BoardPreferences,
): Promise<void> {
  await load(projectId);
  const next = update(preferences[projectId] ?? EMPTY);
  await writeKanbanPreferences(projectId, JSON.stringify(next));
  preferences = { ...preferences, [projectId]: next };
  notifySubscribers();
}

/** Persists one atomic project-board change before publishing it to subscribers. */
export function updateBoardPreferences(
  projectId: string,
  update: (current: BoardPreferences) => BoardPreferences,
): Promise<void> {
  const run = writes.then(
    () => mutate(projectId, update),
    () => mutate(projectId, update),
  );
  // Each caller receives its own failure; later independent writes can still run.
  writes = run.catch(() => undefined);
  return run;
}

/** Keeps a review-fix worktree in progress until explicitly completed. */
export function markBoardFixInProgress(projectId: string, worktreeId: string): Promise<void> {
  return updateBoardPreferences(projectId, (current) => ({
    ...current,
    overrides: { ...current.overrides, [worktreeId]: "inProgress" },
  }));
}
