import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "@/lib/kanban-model";

const mocks = vi.hoisted(() => ({
  openCardWorktree: vi.fn(),
  openFileLocation: vi.fn(),
  activateTabLocation: vi.fn(),
}));
vi.mock("@/state/kanban-context", () => ({
  useKanban: () => ({ openCardWorktree: mocks.openCardWorktree }),
}));
vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    ...mocks,
    worktrees: { p: [{ id: "worktree", path: "/repo" }] },
    projectTabs: [
      {
        id: "first",
        worktreeId: "worktree",
        kind: "terminal",
        agentId: "agent",
        title: "First agent",
      },
      {
        id: "second",
        worktreeId: "worktree",
        kind: "terminal",
        agentId: "agent",
        title: "Second agent",
      },
    ],
  }),
}));
vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: ({ tab, active }: { tab: { id: string }; active: boolean }) => (
    <div data-testid={`terminal-${tab.id}`}>{active ? "Live terminal" : "Hidden terminal"}</div>
  ),
}));
vi.mock("@/components/kanban/BoardAgentProgress", () => ({
  BoardAgentProgress: () => <div>Agent progress</div>,
}));
vi.mock("@/components/right-sidebar/PullRequestTab", () => ({
  PullRequestTab: ({
    worktreeId,
    onOpenFile,
  }: {
    worktreeId: string;
    onOpenFile: (path: string) => void;
  }) => <button onClick={() => onOpenFile("src/file.ts")}>PR sidebar {worktreeId}</button>,
}));
vi.mock("@/components/github/ReviewTab", () => ({
  ReviewTab: ({ tab }: { tab: { prNumber: number } }) => <div>Review files #{tab.prNumber}</div>,
}));
vi.mock("@/components/fanout/FanoutComparison", () => ({
  FanoutComparison: () => <div>Full comparison</div>,
}));
vi.mock("@/components/kanban/KanbanChangesPanel", () => ({
  KanbanChangesPanel: ({
    onOpenFile,
  }: {
    onOpenFile: (target: { path: string; commit: string | null }) => void;
  }) => (
    <button onClick={() => onOpenFile({ path: "README.md", commit: null })}>Changes panel</button>
  ),
}));
vi.mock("@/components/editor/DiffView", () => ({
  DiffView: ({ tab }: { tab: { filePath: string | null } }) => <div>Diff {tab.filePath}</div>,
}));

import { KanbanWorktreeDialog } from "./KanbanWorktreeDialog";

const card: BoardCard = {
  id: "card",
  projectId: "p",
  worktreeId: "worktree",
  branchName: "feature",
  prompt: "Fix",
  agentId: "agent",
  status: "inProgress",
  schedulingMode: "manual",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  pullRequestNumber: 42,
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("board worktree popup", () => {
  it("shows every live agent terminal rather than the PR when work is in progress", () => {
    render(<KanbanWorktreeDialog card={card} onClose={vi.fn()} onPicked={vi.fn()} />);
    expect(screen.getAllByText("Live terminal")).toHaveLength(2);
    expect(screen.queryByText(/PR sidebar/)).not.toBeInTheDocument();
  });
  it("opens the normal workspace with the return affordance from its top-right action", () => {
    const onClose = vi.fn();
    render(<KanbanWorktreeDialog card={card} onClose={onClose} onPicked={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open worktree" }));
    expect(mocks.openCardWorktree).toHaveBeenCalledWith(card);
    expect(onClose).toHaveBeenCalled();
  });
  it("shows the agent beside changed files and opens a diff with a back control for idle work", () => {
    render(
      <KanbanWorktreeDialog
        card={{ ...card, status: "reviewNeeded", pullRequestNumber: null }}
        onClose={vi.fn()}
        onPicked={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Live terminal")).toHaveLength(2);
    expect(screen.getByText("Changes panel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Changes panel" }));
    expect(screen.getByText("Diff README.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to agent" }));
    expect(screen.queryByText("Diff README.md")).not.toBeInTheDocument();
    expect(screen.getAllByText("Live terminal")).toHaveLength(2);
  });
  it("embeds PR details beside review files and exits to the correct worktree on file navigation", () => {
    const onClose = vi.fn();
    render(
      <KanbanWorktreeDialog
        card={{ ...card, status: "reviewNeeded" }}
        onClose={onClose}
        onPicked={vi.fn()}
      />,
    );
    expect(screen.getByText("Review files #42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "PR sidebar worktree" }));
    expect(mocks.openCardWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "worktree", agentTabId: null }),
    );
    expect(mocks.openFileLocation).toHaveBeenCalledWith({
      projectId: "p",
      worktreeId: "worktree",
      path: "src/file.ts",
    });
    expect(onClose).toHaveBeenCalled();
  });
});
