import { describe, expect, it } from "vitest";

import { SUGGESTED_DRAFT_PAGE_SIZE, type PluginContext } from "@pragma-sh/plugin";

import { testSuggestionsProvider } from "./test-suggestions";

const ctx = {} as PluginContext;
const project = { id: "p1", name: "Demo", path: "/tmp/demo" };
const worktree = { id: "w1", path: "/tmp/demo/wt", branch: "feat/x" };

describe("testSuggestionsProvider", () => {
  it("offers more than one board page of drafts", async () => {
    const drafts = await testSuggestionsProvider.suggest(
      { project, worktree, limit: 100, signal: new AbortController().signal },
      ctx,
    );
    expect(drafts.length).toBeGreaterThan(SUGGESTED_DRAFT_PAGE_SIZE);
    expect(drafts[0]).toMatchObject({
      id: "dev-1",
      branchName: "dev-suggestion-1",
      title: "Dev suggestion #1",
    });
  });

  it("honors the requested limit", async () => {
    const drafts = await testSuggestionsProvider.suggest(
      { project, worktree, limit: 3, signal: new AbortController().signal },
      ctx,
    );
    expect(drafts).toHaveLength(3);
  });

  it("names the active project and worktree", async () => {
    const drafts = await testSuggestionsProvider.suggest(
      { project, worktree, limit: 1, signal: new AbortController().signal },
      ctx,
    );
    expect(drafts[0]!.description).toBe("For Demo on feat/x");
  });
});
