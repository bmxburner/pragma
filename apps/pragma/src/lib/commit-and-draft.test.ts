import { describe, expect, it, vi } from "vitest";

import { commitThenDraftPullRequest } from "./commit-and-draft";

describe("commitThenDraftPullRequest", () => {
  it("commits before drafting when the worktree has changes", async () => {
    const commitAndDraft = vi.fn(async () => ({ title: "T", body: "B", commitCount: 2 }));
    const draftOnly = vi.fn(async () => ({ title: "unused", body: "unused" }));
    const result = await commitThenDraftPullRequest({
      dirty: async () => true,
      commitAndDraft,
      draftOnly,
    });
    expect(result).toEqual({ title: "T", body: "B", commitCount: 2 });
    expect(commitAndDraft).toHaveBeenCalledOnce();
    expect(draftOnly).not.toHaveBeenCalled();
  });

  it("drafts from existing commits without committing a clean worktree", async () => {
    const commitAndDraft = vi.fn(async () => ({ title: "unused", body: "unused", commitCount: 9 }));
    const draftOnly = vi.fn(async () => ({ title: "T", body: "B" }));
    const result = await commitThenDraftPullRequest({
      dirty: async () => false,
      commitAndDraft,
      draftOnly,
    });
    expect(result).toEqual({ title: "T", body: "B", commitCount: 0 });
    expect(commitAndDraft).not.toHaveBeenCalled();
    expect(draftOnly).toHaveBeenCalledOnce();
  });
});
