import { describe, expect, it } from "vitest";
import { planBoardMove } from "./kanban-board-move";

const plain = { fanout: undefined, pullRequestNumber: null };
const withPr = { fanout: undefined, pullRequestNumber: 42 };
const fanout = { fanout: {} as never, pullRequestNumber: null };

describe("board drag routing", () => {
  it("only starts a draft into In progress", () => {
    expect(planBoardMove("draft", "inProgress", plain)).toEqual({ kind: "start" });
    expect(planBoardMove("draft", "completed", plain)).toEqual({ kind: "blocked" });
    expect(planBoardMove("inProgress", "draft", plain)).toEqual({ kind: "blocked" });
  });
  it("moves idle and running worktrees between workflow columns", () => {
    expect(planBoardMove("reviewNeeded", "inProgress", plain)).toEqual({
      kind: "move",
      status: "inProgress",
    });
    expect(planBoardMove("completed", "reviewNeeded", plain)).toEqual({
      kind: "move",
      status: "reviewNeeded",
    });
  });
  it("asks how to complete only for a PR-less worktree", () => {
    expect(planBoardMove("reviewNeeded", "completed", plain)).toEqual({ kind: "completionDialog" });
    expect(planBoardMove("reviewNeeded", "completed", withPr)).toEqual({
      kind: "move",
      status: "completed",
    });
  });
  it("opens the comparison before completing an unpicked fanout", () => {
    expect(planBoardMove("reviewNeeded", "completed", fanout)).toEqual({
      kind: "fanoutCompletion",
    });
  });
  it("treats an unchanged column as a no-op", () => {
    expect(planBoardMove("completed", "completed", plain)).toEqual({ kind: "noop" });
  });
});
