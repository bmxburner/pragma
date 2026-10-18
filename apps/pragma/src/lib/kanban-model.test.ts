import { describe, expect, it } from "vitest";
import type { Fanout, KanbanPromptCard, Worktree } from "@pragma-sh/constants";
import type { AgentStatusEntry } from "@/state/agent-status-store";
import { projectBoardCards } from "./kanban-model";

const main: Worktree = {
  id: "main",
  projectId: "p",
  parentId: null,
  branch: "main",
  title: null,
  path: "/repo",
  isMain: true,
  hidden: false,
  createdAt: "2026-01-01",
};
const feature: Worktree = {
  ...main,
  id: "feature",
  branch: "feature",
  parentId: "main",
  isMain: false,
};
const saved: KanbanPromptCard = {
  id: "card",
  projectId: "p",
  branchName: "feature",
  worktreeId: "feature",
  prompt: "Build it",
  agentId: "agent",
  status: "inProgress",
  schedulingMode: "manual",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const running: AgentStatusEntry = {
  worktreeId: "feature",
  tabId: "tab",
  agent: "agent",
  status: "running",
};
const fanout: Fanout = {
  id: "fanout",
  projectId: "p",
  parentWorktreeId: "feature",
  sourceWorktreeId: "main",
  ownsParent: true,
  baseCommit: "abc",
  title: "Attempts",
  prompt: "Build it",
  status: "active",
  winningMemberId: null,
  finalizeStage: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  members: ["attempt-a", "attempt-b"].map((id, ordinal) => ({
    id,
    ordinal,
    selector: "agent",
    catalogAgentId: "agent",
    runtimeAgentId: "agent",
    modelId: null,
    reasoningId: null,
    branch: id,
    worktreeId: id,
    tabId: id,
    priorTabIds: [],
    status: "running",
    failure: null,
  })),
};

describe("live worktree board", () => {
  it("discovers existing worktrees without a card and excludes the root", () => {
    expect(projectBoardCards([], [main, feature], [], [], [], {})).toMatchObject([
      { worktreeId: "feature", status: "reviewNeeded" },
    ]);
  });
  it("omits hidden worktrees, like the sidebar, even when they have a card", () => {
    const hidden: Worktree = { ...feature, id: "hidden", branch: "hidden", hidden: true };
    expect(projectBoardCards([], [main, hidden], [], [], [], {})).toEqual([]);
    const hiddenCard = { ...saved, worktreeId: "hidden" };
    expect(projectBoardCards([hiddenCard], [main, hidden], [], [], [], {})).toEqual([]);
  });
  it("removes deleted worktrees while preserving unstarted drafts", () => {
    const draft = { ...saved, id: "draft", worktreeId: null, status: "draft" as const };
    expect(projectBoardCards([saved, draft], [main], [], [], [], {})).toEqual([draft]);
  });
  it("waits for every ordinary agent to finish before review", () => {
    const done = { ...running, tabId: "done", status: "done" as const };
    expect(projectBoardCards([saved], [feature], [], [done, running], [], {})[0]?.status).toBe(
      "inProgress",
    );
    expect(projectBoardCards([saved], [feature], [], [done], [], {})[0]?.status).toBe(
      "reviewNeeded",
    );
  });
  it("does not automatically complete cards with a PR", () => {
    expect(
      projectBoardCards([{ ...saved, pullRequestNumber: 42 }], [feature], [], [], [], {})[0]
        ?.status,
    ).toBe("reviewNeeded");
  });
  it("keeps fix-it work in progress after agents finish until manually completed", () => {
    expect(
      projectBoardCards([saved], [feature], [], [], [], { feature: "inProgress" })[0]?.status,
    ).toBe("inProgress");
    expect(
      projectBoardCards([saved], [feature], [], [], [], { feature: "completed" })[0]?.status,
    ).toBe("completed");
    expect(
      projectBoardCards([saved], [feature], [], [running], [], { feature: "completed" })[0]?.status,
    ).toBe("inProgress");
  });
  it("groups unpicked attempts and leaves only the parent after finalization", () => {
    const attempts = fanout.members.map((member) => ({
      ...feature,
      id: member.id,
      branch: member.branch,
      parentId: feature.id,
    }));
    const cards = projectBoardCards([], [main, feature, ...attempts], [], [], [fanout], {});
    expect(cards).toHaveLength(1);
    expect(cards[0]?.fanout?.members).toHaveLength(2);
    const finalized = projectBoardCards(
      [],
      [main, feature],
      [],
      [],
      [{ ...fanout, status: "completed" }],
      {},
    );
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.fanout).toBeUndefined();
    expect(finalized[0]?.status).toBe("reviewNeeded");
  });
});
