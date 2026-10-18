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

const ACTIVE_STATUSES = new Set(["running", "attention"]);
const ACTIVE_MEMBER_STATUSES = new Set(["running", "attention", "pending"]);

function liveFanoutsFor(fanouts: Fanout[], worktrees: Worktree[]): Fanout[] {
  return fanouts.filter(
    (fanout) =>
      fanout.status !== "completed" &&
      fanout.status !== "cancelled" &&
      worktrees.some((worktree) => worktree.id === fanout.parentWorktreeId),
  );
}

function memberWorktreeIds(fanout: Fanout | undefined): string[] {
  return fanout?.members.flatMap((member) => (member.worktreeId ? [member.worktreeId] : [])) ?? [];
}

function isWorktreeRunning(
  worktreeId: string,
  fanout: Fanout | undefined,
  statuses: AgentStatusEntry[],
): boolean {
  const relatedIds = new Set([worktreeId, ...memberWorktreeIds(fanout)]);
  const agentActive = statuses.some(
    (entry) => relatedIds.has(entry.worktreeId) && ACTIVE_STATUSES.has(entry.status),
  );
  return (
    agentActive ||
    Boolean(fanout?.members.some((member) => ACTIVE_MEMBER_STATUSES.has(member.status)))
  );
}

function boardStatus(
  running: boolean,
  override: BoardPreferences["overrides"][string] | undefined,
  existing: KanbanPromptCard | undefined,
): KanbanPromptCard["status"] {
  if (running || override === "inProgress") return "inProgress";
  if (override === "completed") return "completed";
  if (override === undefined && existing?.status === "completed") return "completed";
  return "reviewNeeded";
}

interface WorktreeCardInput {
  worktree: Worktree;
  existing: KanbanPromptCard | undefined;
  fanout: Fanout | undefined;
  agentTab: Tab | undefined;
  status: KanbanPromptCard["status"];
}

/** A worktree with no saved card gets one named after its checkout. */
function defaultWorktreeCard(
  worktree: Worktree,
  fanout: Fanout | undefined,
  agentTab: Tab | undefined,
): Omit<KanbanPromptCard, "status"> {
  return {
    id: `worktree:${worktree.id}`,
    projectId: worktree.projectId,
    branchName: worktree.branch,
    prompt: fanout?.prompt ?? worktree.title ?? worktree.branch,
    schedulingMode: "manual",
    agentId: agentTab?.agentId ?? "",
    createdAt: worktree.createdAt,
    updatedAt: worktree.createdAt,
  };
}

function worktreeCard({
  worktree,
  existing,
  fanout,
  agentTab,
  status,
}: WorktreeCardInput): BoardCard {
  return {
    modelId: null,
    reasoningId: null,
    ...(existing ?? defaultWorktreeCard(worktree, fanout, agentTab)),
    worktreeId: worktree.id,
    agentTabId: agentTab?.id ?? existing?.agentTabId ?? null,
    status,
    ...(fanout ? { fanout } : {}),
  };
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
  const liveFanouts = liveFanoutsFor(fanouts, worktrees);
  const attempts = new Set(liveFanouts.flatMap(memberWorktreeIds));
  const cards: BoardCard[] = saved.filter(
    (card) => !card.worktreeId && (card.status === "draft" || card.status === "inProgress"),
  );
  for (const worktree of worktrees) {
    if (worktree.isMain || worktree.hidden || attempts.has(worktree.id)) continue;
    const existing = saved.find((card) => card.worktreeId === worktree.id);
    const fanout = liveFanouts.find((item) => item.parentWorktreeId === worktree.id);
    const running = isWorktreeRunning(worktree.id, fanout, statuses);
    cards.push(
      worktreeCard({
        worktree,
        existing,
        fanout,
        agentTab: tabs.find((tab) => tab.worktreeId === worktree.id && tab.agentId),
        status: boardStatus(running, overrides[worktree.id], existing),
      }),
    );
  }
  return cards;
}
