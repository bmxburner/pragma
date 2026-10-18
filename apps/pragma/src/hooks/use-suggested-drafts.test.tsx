import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type SuggestedDraftInput, SuggestedDraftProviderNotice } from "@pragma-sh/plugin/catalog";

import type { ActiveSuggestedDraftProvider } from "@/plugins/suggested-drafts";

import { useSuggestedDrafts } from "./use-suggested-drafts";

const project = { id: "p", name: "Repo", path: "/repo" };
const worktree = { id: "main", path: "/repo", branch: "main" };

function provider(
  key: string,
  suggest: ActiveSuggestedDraftProvider["suggest"],
): ActiveSuggestedDraftProvider {
  return {
    key,
    title: key,
    icon: null,
    iconUrl: null,
    draftIconUrl: () => null,
    suggest,
  };
}

describe("useSuggestedDrafts", () => {
  it("collects each provider's drafts under a stable key", async () => {
    const providers = [
      provider("builtin:github", async () => [
        { id: "issue-1", branchName: "issue-1", prompt: "Fix one" },
      ]),
      provider("acme:linear", async () => [
        { id: "ENG-2", branchName: "eng-2", prompt: "Fix two" },
      ]),
    ];
    const { result } = renderHook(() =>
      useSuggestedDrafts({ isOpen: true, providers, project, worktree }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.suggestions.map((entry) => entry.key)).toEqual([
      "builtin:github:issue-1",
      "acme:linear:ENG-2",
    ]);
  });

  it("surfaces a provider notice instead of dropping it silently", async () => {
    const providers = [
      provider("builtin:github", async () => {
        throw new SuggestedDraftProviderNotice("Sign in to GitHub");
      }),
      provider("acme:linear", async () => [{ id: "ENG-1", branchName: "eng-1", prompt: "Fix" }]),
    ];
    const { result } = renderHook(() =>
      useSuggestedDrafts({ isOpen: true, providers, project, worktree }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.notices).toEqual(["Sign in to GitHub"]);
    expect(result.current.suggestions).toHaveLength(1);
  });

  it("asks every provider for the active project", async () => {
    const suggest = vi.fn(async (_input: SuggestedDraftInput) => []);
    const providers = [provider("x", suggest)];
    renderHook(() => useSuggestedDrafts({ isOpen: true, providers, project, worktree }));
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    expect(suggest.mock.calls[0]![0]).toMatchObject({ project, worktree });
  });

  it("reports nothing while closed", async () => {
    const suggest = vi.fn(async () => [{ id: "a", branchName: "a", prompt: "" }]);
    const providers = [provider("x", suggest)];
    const { result } = renderHook(() =>
      useSuggestedDrafts({ isOpen: false, providers, project, worktree }),
    );
    expect(result.current.suggestions).toEqual([]);
    expect(suggest).not.toHaveBeenCalled();
  });
});
