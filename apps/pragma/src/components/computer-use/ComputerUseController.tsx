import { useEffect, useRef } from "react";

import { ComputerApprovalDialog } from "@/components/computer-use/ComputerApprovalDialog";
import { computerPipClose, computerPipHide, computerPipShow } from "@/lib/tauri";
import { useComputerUse } from "@/state/computer-use-store";
import { useWorkspace } from "@/state/workspace-context";

/** The PiP key for sessions that belong to no worktree (scripts, the SDK). */
export const NO_WORKTREE_PIP = "none";

/**
 * Main-window half of computer use: decides which picture-in-picture windows
 * are visible, and shows approval prompts.
 *
 * A worktree's PiP is visible only while that worktree is selected here, so
 * switching worktrees never leaves another worktree's agent on screen; the
 * sidebar indicator brings it back. Sessions with no worktree have one PiP
 * that is always shown while they run. A PiP closes when its last session
 * ends.
 */
export function ComputerUseController() {
  const { snapshot } = useComputerUse();
  const { selectedWorktreeId } = useWorkspace();
  const open = useRef(new Set<string>());

  const sessions = snapshot?.sessions ?? [];
  const keys = new Set(sessions.map((session) => session.worktreeId ?? NO_WORKTREE_PIP));
  const signature = [...keys].toSorted().join("\0");

  useEffect(() => {
    const live = new Set(signature ? signature.split("\0") : []);
    for (const key of open.current) {
      if (!live.has(key)) {
        void computerPipClose(key).catch(() => undefined);
        open.current.delete(key);
      }
    }
    for (const key of live) {
      const visible = key === NO_WORKTREE_PIP || key === selectedWorktreeId;
      if (visible) {
        void computerPipShow(key).catch(() => undefined);
        open.current.add(key);
      } else if (open.current.has(key)) {
        void computerPipHide(key).catch(() => undefined);
      }
    }
  }, [signature, selectedWorktreeId]);

  return <ComputerApprovalDialog approvals={snapshot?.approvals ?? []} />;
}
