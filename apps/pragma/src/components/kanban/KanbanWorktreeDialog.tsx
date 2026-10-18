import { useState } from "react";

import { SquareArrowOutUpRight, X } from "lucide-react";

import type { BoardCard } from "@/lib/kanban-model";
import { DiffView } from "@/components/editor/DiffView";
import { FanoutComparison } from "@/components/fanout/FanoutComparison";
import { KanbanChangesPanel, type KanbanFileTarget } from "@/components/kanban/KanbanChangesPanel";
import { PullRequestTab } from "@/components/right-sidebar/PullRequestTab";
import { ReviewTab } from "@/components/github/ReviewTab";
import { TerminalView } from "@/components/terminal/TerminalView";
import { BoardAgentProgress } from "@/components/kanban/BoardAgentProgress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

/** Real terminal, changed files, PR review, or full fanout comparison embedded in the board. */
export function KanbanWorktreeDialog({
  card,
  onClose,
  onPicked,
}: {
  card: BoardCard;
  onClose: () => void;
  onPicked: () => void;
}) {
  const workspace = useWorkspace();
  const kanban = useKanban();
  const worktree = workspace.worktrees[card.projectId]?.find((item) => item.id === card.worktreeId);
  const tabs = workspace.projectTabs.filter(
    (tab) => tab.worktreeId === card.worktreeId && tab.kind === "terminal" && tab.agentId,
  );
  // The diff opened over the agent; null shows the live agent terminals.
  const [openFile, setOpenFile] = useState<KanbanFileTarget | null>(null);
  function navigate(worktreeId: string, tabId?: string | null, path?: string) {
    kanban.openCardWorktree({ ...card, worktreeId, agentTabId: tabId ?? null });
    if (path) void workspace.openFileLocation({ projectId: card.projectId, worktreeId, path });
    else if (tabId) void workspace.activateTabLocation(card.projectId, worktreeId, tabId);
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[95vw]">
        <DialogHeader className="flex shrink-0 flex-row items-center gap-3 border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="min-w-0 flex-1 truncate">
            {card.fanout ? "Choose an implementation" : card.branchName}
          </DialogTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              kanban.openCardWorktree(card);
              onClose();
            }}
          >
            <SquareArrowOutUpRight className="size-3.5" />
            Open worktree
          </Button>
        </DialogHeader>
        {card.fanout ? (
          <FanoutComparison
            fanout={card.fanout}
            onClose={onClose}
            onPicked={onPicked}
            onNavigate={navigate}
          />
        ) : // A running card always shows its agents; a PR card that is idle shows
        // the PR review instead of the (finished) agent.
        card.status !== "inProgress" && card.pullRequestNumber && card.worktreeId ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
            <div className="min-h-0 overflow-auto border-r border-border md:w-[38%]">
              <PullRequestTab
                worktreeId={card.worktreeId}
                onOpenFile={(path) => navigate(card.worktreeId!, null, path)}
              />
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              <ReviewTab tab={{ worktreeId: card.worktreeId, prNumber: card.pullRequestNumber }} />
            </div>
          </div>
        ) : card.worktreeId ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {openFile ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-sm">
                    <IconButton
                      label="Back to agent"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => setOpenFile(null)}
                    >
                      <X />
                    </IconButton>
                    <span className="min-w-0 flex-1 truncate font-medium">{openFile.path}</span>
                  </div>
                  <div className="min-h-0 flex-1">
                    <DiffView
                      tab={{
                        id: `kanban-diff:${card.worktreeId}`,
                        worktreeId: card.worktreeId,
                        filePath: openFile.path,
                        diffSide: "worktree",
                        diffCommit: openFile.commit,
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
                  {/* `BoardAgentProgress` carries `flex-1`; pin it so the terminal grows, not the bar. */}
                  {worktree ? (
                    <div className="shrink-0">
                      <BoardAgentProgress worktreeId={worktree.id} />
                    </div>
                  ) : null}
                  {tabs.length ? (
                    tabs.map((tab) => (
                      // Each agent section grows to fill the dialog; `min-h-80` keeps a
                      // floor so several sessions share the space and the pane scrolls.
                      <section
                        key={tab.id}
                        className="mt-3 flex min-h-80 flex-1 flex-col overflow-hidden rounded-lg border border-border"
                      >
                        <div className="flex shrink-0 items-center border-b border-border px-3 py-2 text-sm">
                          <span className="flex-1">{tab.title ?? tab.agentId}</span>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => navigate(tab.worktreeId, tab.id)}
                          >
                            Open agent
                          </Button>
                        </div>
                        <div className="min-h-0 flex-1">
                          <TerminalView tab={tab} cwd={worktree?.path ?? ""} active />
                        </div>
                      </section>
                    ))
                  ) : (
                    <p className="p-4 text-sm text-muted-foreground">
                      No agent terminals remain in this worktree.
                    </p>
                  )}
                </div>
              )}
            </main>
            <aside className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-border md:w-[22rem] md:border-t-0 md:border-l">
              <KanbanChangesPanel onOpenFile={setOpenFile} worktreeId={card.worktreeId} />
            </aside>
          </div>
        ) : (
          <div className="min-h-0 flex-1 p-6 text-sm text-muted-foreground">
            This card has no worktree to preview.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
