import { describe, expect, it } from "vitest";

import { issueBranchName, issueDraftPrompt } from "./builtin-suggested-drafts";

describe("issueBranchName", () => {
  it("builds a lowercase hyphenated branch from the issue title", () => {
    expect(issueBranchName(12, "Fix the Login crash!")).toBe("issue-12-fix-the-login-crash");
  });

  it("falls back to the number when the title has no usable characters", () => {
    expect(issueBranchName(7, "!!!")).toBe("issue-7");
    expect(issueBranchName(7, "  ")).toBe("issue-7");
  });

  it("truncates a long title without a trailing hyphen", () => {
    const branch = issueBranchName(3, "a".repeat(80));
    expect(branch).toBe(`issue-3-${"a".repeat(40)}`);
  });
});

describe("issueDraftPrompt", () => {
  it("names the issue and tells the agent how to read it", () => {
    const prompt = issueDraftPrompt(42, "Crash on launch");
    expect(prompt).toContain("GitHub issue #42: Crash on launch");
    expect(prompt).toContain("gh issue view 42 --comments");
  });
});
