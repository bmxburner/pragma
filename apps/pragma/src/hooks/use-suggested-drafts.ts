import { useEffect, useState } from "react";

import {
  isSuggestedDraftProviderNotice,
  SUGGESTED_DRAFT_PAGE_SIZE,
  type ContextWorktree,
  type PluginProject,
  type SuggestedDraft,
} from "@pragma-sh/plugin/catalog";

import { useStableProject, useStableWorktree } from "@/lib/stable-context-target";
import type { ActiveSuggestedDraftProvider } from "@/plugins/suggested-drafts";

/**
 * Most suggested drafts requested per provider. The board shows
 * {@link SUGGESTED_DRAFT_PAGE_SIZE} at a time; the rest wait behind "Load more"
 * without a second round-trip.
 */
const SUGGESTED_DRAFT_FETCH_LIMIT = SUGGESTED_DRAFT_PAGE_SIZE * 5;

/** One ghost card: a provider's suggested draft. */
export interface BoardSuggestion {
  /** Stable across refetches: `providerKey:draftId`. */
  key: string;
  provider: ActiveSuggestedDraftProvider;
  draft: SuggestedDraft;
}

/** What the board needs to render the Drafts column's suggestions. */
export interface SuggestedDraftsState {
  suggestions: BoardSuggestion[];
  /** Provider messages shown instead of cards (e.g. "Sign in to GitHub…"). */
  notices: string[];
  loading: boolean;
}

/**
 * Collects suggested drafts from every provider for the active project. Each
 * provider is asked once per project/worktree and aborted when either changes;
 * a provider that raises a notice contributes that message instead of cards.
 */
export function useSuggestedDrafts({
  isOpen,
  providers,
  project: projectInput,
  worktree: worktreeInput,
}: {
  isOpen: boolean;
  providers: ActiveSuggestedDraftProvider[];
  project: PluginProject | null | undefined;
  worktree: ContextWorktree | null | undefined;
}): SuggestedDraftsState {
  const project = useStableProject(projectInput);
  const worktree = useStableWorktree(worktreeInput);
  const [suggestions, setSuggestions] = useState<BoardSuggestion[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !project) {
      setSuggestions([]);
      setNotices([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const input = {
      project,
      worktree,
      limit: SUGGESTED_DRAFT_FETCH_LIMIT,
      signal: controller.signal,
    };
    void Promise.all(
      providers.map((provider) =>
        provider
          .suggest(input)
          .then((drafts) => ({ provider, drafts, notice: undefined }))
          .catch((cause: unknown) => {
            if (isSuggestedDraftProviderNotice(cause))
              return { provider, drafts: [] as SuggestedDraft[], notice: cause.message };
            console.warn(`suggested-draft provider ${provider.key} failed`, cause);
            return { provider, drafts: [] as SuggestedDraft[], notice: undefined };
          }),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return undefined;
      setSuggestions(
        results.flatMap(({ provider, drafts }) =>
          drafts.map((draft) => ({ key: `${provider.key}:${draft.id}`, provider, draft })),
        ),
      );
      setNotices([...new Set(results.flatMap(({ notice }) => (notice ? [notice] : [])))]);
      setLoading(false);
      return undefined;
    });
    return () => controller.abort();
  }, [isOpen, providers, project, worktree]);

  return { suggestions, notices, loading };
}
