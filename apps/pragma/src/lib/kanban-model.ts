import type { Fanout, KanbanPromptCard, Tab, Worktree } from "@pragma-sh/constants";
import type { AgentStatusEntry } from "@/state/agent-status-store";

/** A saved attempt selector; execution remains owned by the host fanout API. */
export interface BoardAttempt {
  key: string;
  selector: string;
  modelId: string | null;
  reasoningId: string | null;
}

/** A board projection can represent a draft, one checkout, or an unpicked fanout. */
export interface BoardCard extends KanbanPromptCard {
  fanout?: Fanout;
  attempts?: BoardAttempt[];
}

/** Cosmetic grouping and explicit workflow choices for one project board. */
export interface BoardPreferences {
  categories: { id: string; name: string; color: string }[];
  assignments: Record<string, string>;
  attempts: Record<string, BoardAttempt[]>;
  /** Manual completion or a fix-it run that must wait for a manual completion. */
  overrides: Record<string, "completed" | "inProgress" | "reviewNeeded">;
  /** Suggested drafts the user dismissed, keyed `providerKey:draftId`. */
  dismissedSuggestions: string[];
}

/** Stable key survives a draft becoming a live worktree projection. */
export function boardCardKey(card: KanbanPromptCard): string {
  return card.worktreeId ?? card.id;
}

/**
 * Builds the board from current checkouts; stale persisted cards never resurrect
 * deleted worktrees. Hidden worktrees are omitted, matching the sidebar, so
 * hiding one takes its card off the board too.
 */
export function projectBoardCards(
  saved: KanbanPromptCard[],
  worktrees: Worktree[],
  tabs: Tab[],
  statuses: AgentStatusEntry[],
  fanouts: Fanout[],
  overrides: BoardPreferences["overrides"],
): BoardCard[] {
  const liveFanouts = fanouts.filter(
    (fanout) =>
      fanout.status !== "completed" &&
      fanout.status !== "cancelled" &&
      worktrees.some((worktree) => worktree.id === fanout.parentWorktreeId),
  );
  const attempts = new Set(
    liveFanouts.flatMap((fanout) => fanout.members.map((member) => member.worktreeId)),
  );
  const cards: BoardCard[] = saved.filter(
    (card) => !card.worktreeId && (card.status === "draft" || card.status === "inProgress"),
  );
  for (const worktree of worktrees) {
    if (worktree.isMain || worktree.hidden || attempts.has(worktree.id)) continue;
    const existing = saved.find((card) => card.worktreeId === worktree.id);
    const fanout = liveFanouts.find((item) => item.parentWorktreeId === worktree.id);
    const relatedIds = new Set([
      worktree.id,
      ...(fanout?.members.flatMap((member) => (member.worktreeId ? [member.worktreeId] : [])) ??
        []),
    ]);
    const running =
      statuses.some(
        (entry) =>
          relatedIds.has(entry.worktreeId) &&
          (entry.status === "running" || entry.status === "attention"),
      ) ||
      Boolean(
        fanout?.members.some(
          (member) =>
            member.status === "running" ||
            member.status === "attention" ||
            member.status === "pending",
        ),
      );
    const agentTab = tabs.find((tab) => tab.worktreeId === worktree.id && tab.agentId);
    const override = overrides[worktree.id];
    cards.push({
      id: existing?.id ?? `worktree:${worktree.id}`,
      projectId: worktree.projectId,
      branchName: worktree.branch,
      prompt: fanout?.prompt ?? existing?.prompt ?? worktree.title ?? worktree.branch,
      schedulingMode: "manual",
      agentId: existing?.agentId ?? agentTab?.agentId ?? "",
      modelId: existing?.modelId ?? null,
      reasoningId: existing?.reasoningId ?? null,
      createdAt: existing?.createdAt ?? worktree.createdAt,
      updatedAt: existing?.updatedAt ?? worktree.createdAt,
      ...existing,
      worktreeId: worktree.id,
      agentTabId: agentTab?.id ?? existing?.agentTabId ?? null,
      status:
        running || override === "inProgress"
          ? "inProgress"
          : override === "completed" || (override === undefined && existing?.status === "completed")
            ? "completed"
            : "reviewNeeded",
      ...(fanout ? { fanout } : {}),
    });
  }
  return cards;
}
