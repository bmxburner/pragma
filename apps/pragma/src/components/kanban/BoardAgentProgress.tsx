import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AgentProgressLine } from "@/components/sidebar/AgentProgressLine";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isVisibleAgentStatus } from "@/lib/agent-status-style";
import { useAgentStatusSnapshot, useWorktreeAgentStatus } from "@/state/agent-status-store";

/** Board agent status, including Jev activity/progress on the icon's tooltip. */
export function BoardAgentProgress({
  worktreeId,
  iconOnly = false,
}: {
  worktreeId: string;
  iconOnly?: boolean;
}) {
  const entries = useAgentStatusSnapshot().filter((entry) => entry.worktreeId === worktreeId);
  const status = useWorktreeAgentStatus(worktreeId);
  if (!entries.length) return null;
  const lines = entries.map((entry) =>
    isVisibleAgentStatus(entry.status) ? (
      <AgentProgressLine
        key={`${entry.tabId}:${entry.agent}`}
        worktreeId={worktreeId}
        tabId={entry.tabId}
        agent={entry.agent}
        status={entry.status}
        className="min-w-0 flex-1"
      />
    ) : null,
  );
  if (!iconOnly) return <div className="min-w-0 flex-1 space-y-1">{lines}</div>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={`Agent ${status ?? "idle"}`}>
          <AgentStatusDot status={status} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="w-56 space-y-2">{lines}</TooltipContent>
    </Tooltip>
  );
}
