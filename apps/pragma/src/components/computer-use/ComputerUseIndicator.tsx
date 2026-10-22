import { MousePointer2 } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { computerPipShow } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { controlledApps, sessionsForWorktree, useComputerUse } from "@/state/computer-use-store";

/**
 * The sidebar's "an agent is controlling your computer" badge on a worktree
 * row. It pulses while an action is in flight and turns amber while an
 * approval is waiting; clicking it brings the worktree's picture-in-picture
 * window back.
 */
export function ComputerUseIndicator({ worktreeId }: { worktreeId: string }) {
  const { snapshot, cursors } = useComputerUse();
  const sessions = sessionsForWorktree(snapshot, worktreeId);
  if (sessions.length === 0) return null;
  const waiting = snapshot?.approvals.some((approval) =>
    sessions.some((session) => session.id === approval.sessionId),
  );
  const paused = sessions.every((session) => session.paused);
  const label = sessions
    .map(
      (session) => `${session.owner.label ?? "An agent"} is controlling ${controlledApps(session)}`,
    )
    .join("; ");
  const recent = sessions.some((session) => {
    const cursor = cursors[session.id];
    return cursor !== undefined && Date.now() - cursor.at < 1500;
  });
  return (
    <IconButton
      className={cn(
        "size-5",
        waiting ? "text-warning" : paused ? "text-muted-foreground" : "text-primary",
        recent && !paused ? "animate-pulse" : undefined,
      )}
      data-testid="computer-use-indicator"
      label={label}
      onClick={(event) => {
        event.stopPropagation();
        void computerPipShow(worktreeId);
      }}
      size="icon-xs"
      variant="ghost"
    >
      <MousePointer2 />
    </IconButton>
  );
}
