import type { KanbanPromptStatus } from "@pragma-sh/constants";
import type { BoardCard } from "@/lib/kanban-model";

/**
 * What dropping a card into a column should do. Drafts keep the one-way Start
 * transition; live worktrees move freely between the workflow columns, and the
 * destination decides whether that is a plain move, the completion dialog, or
 * the fanout comparison used to pick an attempt before completing.
 */
export type BoardMovePlan =
  | { kind: "noop" }
  | { kind: "blocked" }
  | { kind: "start" }
  | { kind: "move"; status: Exclude<KanbanPromptStatus, "draft"> }
  | { kind: "completionDialog" }
  | { kind: "fanoutCompletion" };

/** Resolves a board drag into the action the workspace should run. */
export function planBoardMove(
  from: KanbanPromptStatus,
  to: KanbanPromptStatus,
  card: Pick<BoardCard, "fanout" | "pullRequestNumber">,
): BoardMovePlan {
  if (from === to) {
    return { kind: "noop" };
  }
  if (from === "draft") {
    return to === "inProgress" ? { kind: "start" } : { kind: "blocked" };
  }
  if (to === "draft") {
    return { kind: "blocked" };
  }
  if (to === "completed") {
    if (card.fanout) {
      return { kind: "fanoutCompletion" };
    }
    // A worktree that already has a PR is done by definition — no dialog needed.
    return card.pullRequestNumber
      ? { kind: "move", status: "completed" }
      : { kind: "completionDialog" };
  }
  return { kind: "move", status: to };
}
