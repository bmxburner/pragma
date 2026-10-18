import { useMemo } from "react";

import type { ContextWorktree, PluginProject } from "@pragma-sh/plugin";

/**
 * A value-stable {@link PluginProject}: the prompt and board hooks receive fresh
 * project objects every render, but the `@` picker and suggested-draft search
 * key their effects on the project, so identity has to track its fields.
 */
export function useStableProject(project: PluginProject | null | undefined): PluginProject | null {
  const id = project?.id;
  const name = project?.name;
  const path = project?.path;
  return useMemo(
    () =>
      id !== undefined && name !== undefined && path !== undefined ? { id, name, path } : null,
    [id, name, path],
  );
}

/** A value-stable {@link ContextWorktree}, keyed on the fields callers read. */
export function useStableWorktree(
  worktree: ContextWorktree | null | undefined,
): ContextWorktree | null {
  const id = worktree?.id;
  const path = worktree?.path;
  const branch = worktree?.branch;
  return useMemo(
    () =>
      id !== undefined && path !== undefined && branch !== undefined ? { id, path, branch } : null,
    [id, path, branch],
  );
}
