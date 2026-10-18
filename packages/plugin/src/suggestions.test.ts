import { describe, expect, it } from "vitest";

import {
  defineSuggestedDraftProvider,
  isSuggestedDraftProviderNotice,
  SUGGESTED_DRAFT_PAGE_SIZE,
  SuggestedDraftProviderNotice,
} from "./suggestions";

describe("defineSuggestedDraftProvider", () => {
  it("returns the declaration unchanged", () => {
    const provider = defineSuggestedDraftProvider({
      id: "issues",
      title: "Issues",
      suggest: () => [],
    });
    expect(provider.id).toBe("issues");
    expect(provider.title).toBe("Issues");
  });

  it("exports a board page size", () => {
    expect(SUGGESTED_DRAFT_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe("SuggestedDraftProviderNotice", () => {
  it("is recognized by name across plugin bundles", () => {
    expect(isSuggestedDraftProviderNotice(new SuggestedDraftProviderNotice("Sign in"))).toBe(true);
    // A different module instance still carries the same name.
    const foreign = new Error("Sign in");
    foreign.name = "SuggestedDraftProviderNotice";
    expect(isSuggestedDraftProviderNotice(foreign)).toBe(true);
    expect(isSuggestedDraftProviderNotice(new Error("boom"))).toBe(false);
  });
});
