import { useCallback, useEffect, useRef, useState } from "react";

import type { WorktreeChanges } from "@pragma-sh/constants";

import { ChangeGroup } from "@/components/right-sidebar/ChangeGroup";
import { CommittedChangesGroup } from "@/components/right-sidebar/CommittedChangesGroup";
import { startRefreshLoop } from "@/components/right-sidebar/refresh-loop";
import { errorMessage } from "@/lib/errors";
import { worktreeChanges } from "@/lib/tauri";

/** How often the panel re-queries git, matching the Changes sidebar subtab. */
const CHANGES_REFRESH_INTERVAL_MS = 2000;

/** A changed file the board's preview wants to open. */
export interface KanbanFileTarget {
  path: string;
  /** Commit hash for a commit-scoped diff, or null for the worktree-base diff. */
  commit: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; changes: WorktreeChanges }
  | { kind: "error"; message: string };

/** True when two polled change sets are identical, so state can be kept as-is. */
function sameChanges(a: WorktreeChanges, b: WorktreeChanges): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Polls `worktree_changes` for a worktree, dropping stale responses. */
function useKanbanChanges(worktreeId: string): LoadState {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const activeWorktree = useRef(worktreeId);
  activeWorktree.current = worktreeId;

  const refresh = useCallback(async () => {
    try {
      const changes = await worktreeChanges(worktreeId);
      if (activeWorktree.current !== worktreeId) return;
      // Keep the previous object when nothing changed so the poll doesn't
      // re-render the whole panel every tick.
      setState((previous) =>
        previous.kind === "ready" && sameChanges(previous.changes, changes)
          ? previous
          : { kind: "ready", changes },
      );
    } catch (cause) {
      if (activeWorktree.current === worktreeId) {
        setState({ kind: "error", message: errorMessage(cause) });
      }
    }
  }, [worktreeId]);

  useEffect(() => {
    setState({ kind: "loading" });
    return startRefreshLoop(refresh, CHANGES_REFRESH_INTERVAL_MS);
  }, [refresh]);

  return state;
}

/**
 * The changed-files list the board's card preview shows beside the agent: the
 * same `ChangeGroup`/`CommittedChangesGroup` components as the Changes sidebar,
 * read-only (no staging), scoped to the card's worktree. Clicking a file opens
 * its diff in the preview's main pane.
 */
export function KanbanChangesPanel({
  worktreeId,
  onOpenFile,
}: {
  worktreeId: string;
  onOpenFile: (target: KanbanFileTarget) => void;
}) {
  const state = useKanbanChanges(worktreeId);
  const openWorktreeDiff = useCallback(
    (path: string) => onOpenFile({ path, commit: null }),
    [onOpenFile],
  );

  if (state.kind === "loading") {
    return <p className="p-3 text-xs text-muted-foreground">Loading changes…</p>;
  }
  if (state.kind === "error") {
    return <p className="p-3 text-xs text-destructive">{state.message}</p>;
  }
  const { changes } = state;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto py-1">
      <ChangeGroup
        emptyLabel="No staged changes"
        files={changes.staged}
        onOpen={(file) => openWorktreeDiff(file.path)}
        title="Staged changes"
      />
      <ChangeGroup
        emptyLabel="No unstaged changes"
        files={changes.unstaged}
        onOpen={(file) => openWorktreeDiff(file.path)}
        title="Unstaged changes"
      />
      <CommittedChangesGroup
        files={changes.committed}
        onOpenCommitFile={(commit, file) => onOpenFile({ path: file.path, commit: commit.hash })}
        onOpenFile={(file) => openWorktreeDiff(file.path)}
        worktreeId={worktreeId}
      />
    </div>
  );
}
