import { CircleDot } from "lucide-react";

import {
  defineSuggestedDraftProvider,
  type SuggestedDraft,
  type SuggestedDraftProviderDefinition,
  SuggestedDraftProviderNotice,
} from "@pragma-sh/plugin/catalog";

import { GitHubAuthError, listRecentIssues } from "@/lib/github";
import { githubRepoRef } from "@/lib/tauri";

/** `data` carried by a built-in GitHub suggested draft. */
interface IssueSuggestionData {
  number: number;
}

/** Shown when no GitHub token is stored; the board renders it once. */
const GITHUB_SIGN_IN_NOTICE = "Sign in to GitHub (Settings → GitHub) to see issue suggestions.";

/** Most of an issue title that survives into a branch name. */
const BRANCH_SLUG_MAX = 40;

/** Lowercase, hyphenated branch slug derived from an issue title. */
function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX)
    .replace(/-+$/, "");
}

/** Branch name a suggested draft for one issue should start on. */
export function issueBranchName(number: number, title: string): string {
  const slug = branchSlug(title);
  return slug ? `issue-${number}-${slug}` : `issue-${number}`;
}

/** The prompt a suggested issue draft carries into the draft dialog. */
export function issueDraftPrompt(number: number, title: string): string {
  return [
    `Address GitHub issue #${number}: ${title}`,
    "",
    `Run \`gh issue view ${number} --comments\` for the full description and discussion before you start.`,
  ].join("\n");
}

/**
 * Suggests a draft to fix each open GitHub issue in the active project's repo.
 * Pull requests are excluded — those belong to the `@` picker's PR provider.
 */
const githubIssuesProvider = defineSuggestedDraftProvider<unknown, IssueSuggestionData>({
  id: "github-issues",
  title: "GitHub issues",
  icon: CircleDot,
  async suggest({ worktree, limit }) {
    if (!worktree) return [];
    try {
      const repo = await githubRepoRef(worktree.id);
      const issues = (await listRecentIssues(repo))
        .filter((issue) => issue.kind === "issue")
        .slice(0, limit);
      return issues.map(issueSuggestion);
    } catch (cause) {
      if (cause instanceof GitHubAuthError)
        throw new SuggestedDraftProviderNotice(GITHUB_SIGN_IN_NOTICE);
      // Not a GitHub repository (or GitHub is unreachable): offer nothing.
      return [];
    }
  },
});

function issueSuggestion(issue: {
  number: number;
  title: string;
}): SuggestedDraft<IssueSuggestionData> {
  return {
    id: `issue-${issue.number}`,
    branchName: issueBranchName(issue.number, issue.title),
    title: `#${issue.number} ${issue.title}`,
    description: issue.title,
    prompt: issueDraftPrompt(issue.number, issue.title),
    data: { number: issue.number },
  };
}

/** Suggested-draft providers Pragma ships, listed ahead of any plugin's. */
export const BUILTIN_SUGGESTED_DRAFT_PROVIDERS: readonly SuggestedDraftProviderDefinition[] = [
  githubIssuesProvider,
];
