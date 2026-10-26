import { defineSuggestedDraftProvider, SUGGESTED_DRAFT_PAGE_SIZE } from "@pragma-sh/plugin";

/** More than one board page, so the Drafts column's **Load more** control is exercised. */
const SUGGESTION_COUNT = SUGGESTED_DRAFT_PAGE_SIZE + 5;

/**
 * Suggested-draft provider that proposes {@link SUGGESTION_COUNT} canned drafts,
 * for testing the agent board's Drafts suggestions end to end: ghost cards,
 * paging, and the pre-filled draft dialog.
 */
export const testSuggestionsProvider = defineSuggestedDraftProvider({
  id: "test-suggestions",
  title: "Dev test suggestions",
  suggest: ({ project, worktree, limit }) =>
    Array.from({ length: Math.min(limit, SUGGESTION_COUNT) }, (_, index) => {
      const number = index + 1;
      return {
        id: `dev-${number}`,
        branchName: `dev-suggestion-${number}`,
        title: `Dev suggestion #${number}`,
        description: project
          ? `For ${project.name}${worktree ? ` on ${worktree.branch}` : ""}`
          : "A canned dev test draft",
        prompt: `This is dev test suggestion #${number}. Reply with PINEAPPLE when you are done.`,
      };
    }),
});
