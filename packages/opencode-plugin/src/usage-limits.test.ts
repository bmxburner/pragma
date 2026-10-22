import type { PluginContext } from "@pragma-sh/plugin/catalog";
import { describe, expect, it, vi } from "vitest";

import opencodeAgentPlugin from "./pragma-plugin";
import {
  loadOpenCodeGoUsageLimits,
  loadOpenCodeGoUsageLimitsV2,
  openCodeGoUsageWindows,
  parseOpenCodeGoStats,
  parseOpenCodeGoUsage,
} from "./usage-limits";

const aggregate = {
  observedAt: 1_800_000_000_000,
  rollingUsed: 3,
  rollingResetsAt: 1_800_003_600_000,
  weeklyUsed: 12,
  weeklyResetsAt: 1_800_086_400_000,
  monthlyUsed: 24,
  monthlyResetsAt: 1_801_000_000_000,
  messageCount: 10,
};

describe("OpenCode Go usage limits", () => {
  it("registers the provider as an agent capability", () => {
    expect(opencodeAgentPlugin.accounts?.[0]).toMatchObject({
      provider: "opencode-go",
      agent: "opencode",
      usageLimits: { primaryLimitId: "rolling" },
    });
    expect(opencodeAgentPlugin.agents?.[0]?.excludeFeatures ?? []).not.toContain("usageLimits");
  });

  it("normalizes local cost windows and reset times", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify([aggregate]))).toEqual({
      status: "ready",
      observedAt: aggregate.observedAt,
      limits: [
        { id: "rolling", title: "5-hour limit", used: 3, limit: 12, resetsInMs: 3_600_000 },
        { id: "weekly", title: "Weekly limit", used: 12, limit: 30, resetsInMs: 86_400_000 },
        {
          id: "monthly",
          title: "Monthly limit",
          used: 24,
          limit: 60,
          resetsInMs: 1_000_000_000,
        },
      ],
    });
  });

  it("reports unsupported before device-local Go usage exists", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify([{ ...aggregate, messageCount: 0 }]))).toEqual({
      status: "unavailable",
      reason: "unsupported",
      message: "No device-local OpenCode Go usage was found.",
    });
  });

  it("throws for malformed query output", () => {
    expect(() => parseOpenCodeGoUsage("not json")).toThrow("invalid JSON");
    expect(() =>
      parseOpenCodeGoUsage(JSON.stringify([{ ...aggregate, rollingUsed: null }])),
    ).toThrow("malformed 5-hour limit usage");
  });

  it("reports a missing OpenCode installation as not configured", async () => {
    const run = vi.fn().mockResolvedValue([{ status: 20, stdout: "", stderr: "" }]);
    const ctx = { sdk: { exec: { run } }, project: null } as unknown as PluginContext;

    await expect(loadOpenCodeGoUsageLimits(ctx)).resolves.toEqual({
      status: "unavailable",
      reason: "not-configured",
      message: "Install OpenCode to load OpenCode Go usage limits.",
    });
  });
});

describe("OpenCode Go usage limits on OpenCode v2", () => {
  // Wednesday 2027-01-13 12:00 UTC.
  const now = Date.UTC(2027, 0, 13, 12);

  it("uses the v1 query's UTC windows", () => {
    expect(openCodeGoUsageWindows(now)).toEqual([
      { id: "rolling", from: now - 5 * 60 * 60 * 1000, resetsAt: null },
      { id: "weekly", from: Date.UTC(2027, 0, 11), resetsAt: Date.UTC(2027, 0, 18) },
      { id: "monthly", from: Date.UTC(2027, 0, 1), resetsAt: Date.UTC(2027, 1, 1) },
    ]);
  });

  it("sums only the opencode-go models in the server's statistics", () => {
    const stats = {
      data: {
        models: [
          { model: { id: "a", providerID: "opencode-go" }, cost: 1.5, steps: 3 },
          { model: { id: "b", providerID: "openai" }, cost: 9, steps: 9 },
          { model: { id: "c", providerID: "opencode-go" }, cost: 0.5, steps: 1 },
        ],
      },
    };
    expect(parseOpenCodeGoStats(JSON.stringify(stats))).toEqual({ cost: 2, steps: 4 });
  });

  it("reports each window's cost against Go's limits", async () => {
    const costs = [2, 10, 20];
    const run = vi.fn(async ({ commands }: { commands: string[] }) =>
      commands.map((command, index) => ({
        command,
        stderr: "",
        status: 0,
        durationMs: 0,
        stdout: JSON.stringify({
          data: {
            models: [{ model: { providerID: "opencode-go" }, cost: costs[index], steps: 1 }],
          },
        }),
      })),
    );
    const ctx = { project: { path: "/tmp" }, sdk: { exec: { run } } } as unknown as PluginContext;
    expect(await loadOpenCodeGoUsageLimitsV2(ctx, now)).toEqual({
      status: "ready",
      observedAt: now,
      limits: [
        { id: "rolling", title: "5-hour limit", used: 2, limit: 12 },
        {
          id: "weekly",
          title: "Weekly limit",
          used: 10,
          limit: 30,
          resetsInMs: Date.UTC(2027, 0, 18) - now,
        },
        {
          id: "monthly",
          title: "Monthly limit",
          used: 20,
          limit: 60,
          resetsInMs: Date.UTC(2027, 1, 1) - now,
        },
      ],
    });
    expect(run.mock.calls[0]?.[0].commands[0]).toContain("/api/experimental/session/stats?from=");
  });
});
