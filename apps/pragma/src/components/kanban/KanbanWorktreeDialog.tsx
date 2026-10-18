import { useState } from "react";

import { SquareArrowOutUpRight, X } from "lucide-react";

import type { Worktree } from "@pragma-sh/constants";

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

type Navigate = (worktreeId: string, tabId?: string | null, path?: string) => void;
type WorkspaceTab = ReturnType<typeof useWorkspace>["projectTabs"][number];

/** An idle PR card: the pull request beside its review. */
function WorktreePrReview({
  worktreeId,
  prNumber,
  navigate,
}: {
  worktreeId: string;
  prNumber: number;
  navigate: Navigate;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <div className="min-h-0 overflow-auto border-r border-border md:w-[38%]">
        <PullRequestTab
          worktreeId={worktreeId}
          onOpenFile={(path) => navigate(worktreeId, null, path)}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <ReviewTab tab={{ worktreeId, prNumber }} />
      </div>
    </div>
  );
}

/** A changed file's diff, opened over the agent terminals. */
function WorktreeFileDiff({
  worktreeId,
  file,
  onBack,
}: {
  worktreeId: string;
  file: KanbanFileTarget;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-sm">
        <IconButton label="Back to agent" size="icon-sm" variant="ghost" onClick={onBack}>
          <X />
        </IconButton>
        <span className="min-w-0 flex-1 truncate font-medium">{file.path}</span>
      </div>
      <div className="min-h-0 flex-1">
        <DiffView
          tab={{
            id: `kanban-diff:${worktreeId}`,
            worktreeId,
            filePath: file.path,
            diffSide: "worktree",
            diffCommit: file.commit,
          }}
        />
      </div>
    </div>
  );
}

/** One live agent terminal section. */
function WorktreeAgentTerminal({
  tab,
  cwd,
  navigate,
}: {
  tab: WorkspaceTab;
  cwd: string;
  navigate: Navigate;
}) {
  return (
    // Each agent section grows to fill the dialog; `min-h-80` keeps a
    // floor so several sessions share the space and the pane scrolls.
    <section className="mt-3 flex min-h-80 flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex shrink-0 items-center border-b border-border px-3 py-2 text-sm">
        <span className="flex-1">{tab.title ?? tab.agentId}</span>
        <Button size="xs" variant="ghost" onClick={() => navigate(tab.worktreeId, tab.id)}>
          Open agent
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView tab={tab} cwd={cwd} active />
      </div>
    </section>
  );
}

/** The worktree's agent progress and every agent terminal still open in it. */
function WorktreeAgentTerminals({
  worktree,
  tabs,
  navigate,
}: {
  worktree: Worktree | undefined;
  tabs: WorkspaceTab[];
  navigate: Navigate;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      {/* `BoardAgentProgress` carries `flex-1`; pin it so the terminal grows, not the bar. */}
      {worktree ? (
        <div className="shrink-0">
          <BoardAgentProgress worktreeId={worktree.id} />
        </div>
      ) : null}
      {tabs.length ? (
        tabs.map((tab) => (
          <WorktreeAgentTerminal
            key={tab.id}
            tab={tab}
            cwd={worktree?.path ?? ""}
            navigate={navigate}
          />
        ))
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          No agent terminals remain in this worktree.
        </p>
      )}
    </div>
  );
}

/** Agent terminals (or an opened diff) beside the worktree's changed files. */
function WorktreeAgentPane({
  worktreeId,
  worktree,
  tabs,
  navigate,
}: {
  worktreeId: string;
  worktree: Worktree | undefined;
  tabs: WorkspaceTab[];
  navigate: Navigate;
}) {
  // The diff opened over the agent; null shows the live agent terminals.
  const [openFile, setOpenFile] = useState<KanbanFileTarget | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {openFile ? (
          <WorktreeFileDiff
            worktreeId={worktreeId}
            file={openFile}
            onBack={() => setOpenFile(null)}
          />
        ) : (
          <WorktreeAgentTerminals worktree={worktree} tabs={tabs} navigate={navigate} />
        )}
      </main>
      <aside className="flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-t border-border md:w-[22rem] md:border-t-0 md:border-l">
        <KanbanChangesPanel onOpenFile={setOpenFile} worktreeId={worktreeId} />
      </aside>
    </div>
  );
}

/** Picks the dialog body for a card: fanout comparison, PR review, agents, or nothing. */
function KanbanWorktreeBody({
  card,
  navigate,
  onClose,
  onPicked,
}: {
  card: BoardCard;
  navigate: Navigate;
  onClose: () => void;
  onPicked: () => void;
}) {
  const workspace = useWorkspace();
  if (card.fanout)
    return (
      <FanoutComparison
        fanout={card.fanout}
        onClose={onClose}
        onPicked={onPicked}
        onNavigate={navigate}
      />
    );
  if (!card.worktreeId)
    return (
      <div className="min-h-0 flex-1 p-6 text-sm text-muted-foreground">
        This card has no worktree to preview.
      </div>
    );
  // A running card always shows its agents; a PR card that is idle shows
  // the PR review instead of the (finished) agent.
  if (card.status !== "inProgress" && card.pullRequestNumber)
    return (
      <WorktreePrReview
        worktreeId={card.worktreeId}
        prNumber={card.pullRequestNumber}
        navigate={navigate}
      />
    );
  const worktree = workspace.worktrees[card.projectId]?.find((item) => item.id === card.worktreeId);
  const tabs = workspace.projectTabs.filter(
    (tab) => tab.worktreeId === card.worktreeId && tab.kind === "terminal" && tab.agentId,
  );
  return (
    <WorktreeAgentPane
      worktreeId={card.worktreeId}
      worktree={worktree}
      tabs={tabs}
      navigate={navigate}
    />
  );
}

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
        <KanbanWorktreeBody card={card} navigate={navigate} onClose={onClose} onPicked={onPicked} />
      </DialogContent>
    </Dialog>
  );
}
