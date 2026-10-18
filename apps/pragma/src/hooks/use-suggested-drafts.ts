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

/** One provider's settled contribution, kept until the target changes. */
interface ProviderResult {
  suggestions: BoardSuggestion[];
  notice: string | undefined;
}

/** Results tagged with the `project\0worktree` target they were fetched for. */
interface LoadedSuggestions {
  target: string | null;
  suggestions: BoardSuggestion[];
  notices: string[];
  loading: boolean;
}

const IDLE: LoadedSuggestions = { target: null, suggestions: [], notices: [], loading: false };

/** A value-stable identity for the fetch target, so a project switch invalidates results. */
function suggestionTarget(project: PluginProject | null, worktree: ContextWorktree | null): string {
  return `${project?.id ?? ""}\u0000${worktree?.id ?? ""}`;
}

/**
 * Collects suggested drafts from every provider for the active project. Each
 * provider is asked once per project/worktree and aborted when either changes; a
 * provider that raises a notice contributes that message instead of cards.
 *
 * Results are published as each provider settles rather than waiting on
 * `Promise.all`, so one slow provider cannot hold back the others, and the
 * previous target's results are dropped the moment the project changes so they
 * can never be picked or dismissed against the wrong project.
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
  const [state, setState] = useState<LoadedSuggestions>(IDLE);

  useEffect(() => {
    if (!isOpen || !project) {
      setState(IDLE);
      return;
    }
    const target = suggestionTarget(project, worktree);
    const controller = new AbortController();
    const signal = controller.signal;
    const results = new Map<string, ProviderResult>();
    let remaining = providers.length;
    // Drop the previous target's results immediately; they must not stay
    // clickable while this target's fetch is still in flight.
    setState({ target, suggestions: [], notices: [], loading: remaining > 0 });
    const publish = () => {
      if (signal.aborted) return;
      const suggestions = providers.flatMap(
        (provider) => results.get(provider.key)?.suggestions ?? [],
      );
      const notices = [
        ...new Set(
          providers.flatMap((provider) => {
            const notice = results.get(provider.key)?.notice;
            return notice ? [notice] : [];
          }),
        ),
      ];
      setState({ target, suggestions, notices, loading: remaining > 0 });
    };
    const input = {
      project,
      worktree,
      limit: SUGGESTED_DRAFT_FETCH_LIMIT,
      signal,
    };
    for (const provider of providers) {
      void (async () => {
        try {
          const drafts = await provider.suggest(input);
          results.set(provider.key, {
            suggestions: drafts.map((draft) => ({
              key: `${provider.key}:${draft.id}`,
              provider,
              draft,
            })),
            notice: undefined,
          });
        } catch (cause) {
          if (isSuggestedDraftProviderNotice(cause)) {
            results.set(provider.key, { suggestions: [], notice: cause.message });
            return;
          }
          console.warn(`suggested-draft provider ${provider.key} failed`, cause);
          results.set(provider.key, { suggestions: [], notice: undefined });
        } finally {
          remaining -= 1;
          publish();
        }
      })();
    }
    return () => controller.abort();
  }, [isOpen, providers, project, worktree]);

  // Never surface another target's results: while a switch is in flight the
  // board sees an empty, loading list instead of the previous project's cards.
  const target = isOpen && project ? suggestionTarget(project, worktree) : null;
  const current = state.target === target ? state : null;
  return {
    suggestions: current?.suggestions ?? [],
    notices: current?.notices ?? [],
    loading: current ? current.loading : target !== null,
  };
}
