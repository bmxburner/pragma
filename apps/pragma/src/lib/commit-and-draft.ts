import type { AiCommitAndPullRequestDraft, AiPullRequestDraft } from "@/lib/tauri";

/** The three calls a PR completion makes, injected so the rule is testable. */
export interface CommitThenDraftCalls {
  /** Whether the worktree has uncommitted work. */
  dirty: () => Promise<boolean>;
  /** Commit the worktree's changes, then draft the pull request. */
  commitAndDraft: () => Promise<AiCommitAndPullRequestDraft>;
  /** Draft the pull request from the branch's existing commits. */
  draftOnly: () => Promise<AiPullRequestDraft>;
}

/**
 * Produces a pull-request draft, committing first **only** when there is work to
 * commit. A clean worktree — a fanout winner already merged and committed into
 * its parent, say — drafts from the branch's existing commits rather than
 * asking the AI to describe an empty change set, which fails with
 * "There are no changes to commit."
 */
export async function commitThenDraftPullRequest(
  calls: CommitThenDraftCalls,
): Promise<AiCommitAndPullRequestDraft> {
  if (await calls.dirty()) {
    return calls.commitAndDraft();
  }
  const draft = await calls.draftOnly();
  return { ...draft, commitCount: 0 };
}
