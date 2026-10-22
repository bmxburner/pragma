import type { PluginContext, UsageLimit, UsageLimitsResult } from "@pragma-sh/plugin/catalog";

import { pluginCwd } from "./cwd";
import { OPENCODE_MISSING_STATUS, hostQuote, withOpenCode } from "./host-shell";
import { isOpenCodeV2 } from "./opencode-version";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const GO_LIMITS = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

const USAGE_QUERY = `
WITH bounds AS (
  SELECT
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS observed_at,
    CAST(strftime('%s', datetime('now', 'start of day', printf('-%d days', (CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7))) AS INTEGER) * 1000 AS week_start,
    CAST(strftime('%s', 'now', 'start of month') AS INTEGER) * 1000 AS month_start,
    CAST(strftime('%s', 'now', 'start of month', '+1 month') AS INTEGER) * 1000 AS month_end
), usage AS (
  SELECT
    bounds.*,
    COALESCE(SUM(CASE WHEN time_created >= observed_at - ${FIVE_HOURS_MS} THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) AS rolling_used,
    MIN(CASE WHEN time_created >= observed_at - ${FIVE_HOURS_MS} THEN time_created END) AS rolling_start,
    COALESCE(SUM(CASE WHEN time_created >= week_start THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) AS weekly_used,
    COALESCE(SUM(CASE WHEN time_created >= month_start THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) AS monthly_used,
    COUNT(message.id) AS message_count
  FROM bounds
  LEFT JOIN message ON json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.providerID') = 'opencode-go'
)
SELECT
  observed_at AS observedAt,
  rolling_used AS rollingUsed,
  CASE WHEN rolling_start IS NULL THEN NULL ELSE rolling_start + ${FIVE_HOURS_MS} END AS rollingResetsAt,
  weekly_used AS weeklyUsed,
  week_start + ${7 * 24 * 60 * 60 * 1000} AS weeklyResetsAt,
  monthly_used AS monthlyUsed,
  month_end AS monthlyResetsAt,
  message_count AS messageCount
FROM usage
`.trim();

const NOT_INSTALLED: UsageLimitsResult = {
  status: "unavailable",
  reason: "not-configured",
  message: "Install OpenCode to load OpenCode Go usage limits.",
};

const NO_USAGE: UsageLimitsResult = {
  status: "unavailable",
  reason: "unsupported",
  message: "No device-local OpenCode Go usage was found.",
};

/**
 * Loads device-local OpenCode Go usage. OpenCode v1 answers one SQL aggregate
 * through `opencode db`; v2 dropped that command, so its usage comes from the
 * server's session statistics (see {@link loadOpenCodeGoUsageLimitsV2}).
 */
export async function loadOpenCodeGoUsageLimits(ctx: PluginContext): Promise<UsageLimitsResult> {
  if (await isOpenCodeV2(ctx)) return loadOpenCodeGoUsageLimitsV2(ctx);
  const [result] = await ctx.sdk.exec.run({
    cwd: pluginCwd(ctx),
    commands: [withOpenCode(`opencode db ${hostQuote(USAGE_QUERY)} --format json`)],
  });
  if (result?.status === OPENCODE_MISSING_STATUS) return NOT_INSTALLED;
  if (!result || result.status !== 0) {
    throw new Error(result?.stderr.trim() || "OpenCode Go usage query failed");
  }
  return parseOpenCodeGoUsage(result.stdout);
}

/** One cost window, as `GET /api/experimental/session/stats?from=&to=` reports it. */
interface UsageWindow {
  id: "rolling" | "weekly" | "monthly";
  from: number;
  resetsAt: number | null;
}

/**
 * The same three windows as the v1 query, in UTC: the rolling five hours, the
 * week from Monday, and the calendar month. v2's statistics are aggregates, so
 * the rolling window's reset (five hours after its first message) is unknown.
 */
export function openCodeGoUsageWindows(now: number): UsageWindow[] {
  const today = new Date(now);
  const dayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const weekStart = dayStart - ((today.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000;
  const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  return [
    { id: "rolling", from: now - FIVE_HOURS_MS, resetsAt: null },
    { id: "weekly", from: weekStart, resetsAt: weekStart + 7 * 24 * 60 * 60 * 1000 },
    {
      id: "monthly",
      from: monthStart,
      resetsAt: Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
    },
  ];
}

/**
 * OpenCode v2 usage: per-model cost over each window from the server's session
 * statistics (an `experimental` endpoint), summed for the `opencode-go`
 * provider. The service keeps one database for every account, so this is the
 * device's OpenCode Go usage, whichever key it was billed to.
 */
export async function loadOpenCodeGoUsageLimitsV2(
  ctx: PluginContext,
  now: number = Date.now(),
): Promise<UsageLimitsResult> {
  const windows = openCodeGoUsageWindows(now);
  const results = await ctx.sdk.exec.run({
    cwd: pluginCwd(ctx),
    commands: windows.map((window) =>
      withOpenCode(
        `opencode api GET ${hostQuote(`/api/experimental/session/stats?from=${window.from}&to=${now}`)}`,
      ),
    ),
    maxConcurrent: windows.length,
  });
  if (results.some((result) => result.status === OPENCODE_MISSING_STATUS)) return NOT_INSTALLED;
  const usage = windows.map((_window, index) => {
    const result = results[index];
    if (!result || result.status !== 0) {
      throw new Error(result?.stderr.trim() || "OpenCode Go usage query failed");
    }
    return parseOpenCodeGoStats(result.stdout);
  });
  if (usage.every((window) => window.steps === 0)) return NO_USAGE;
  const titles = { rolling: "5-hour limit", weekly: "Weekly limit", monthly: "Monthly limit" };
  return {
    status: "ready",
    observedAt: now,
    limits: windows.map((window, index) =>
      usageLimit(
        window.id,
        titles[window.id],
        usage[index]?.cost,
        GO_LIMITS[window.id],
        window.resetsAt,
        now,
      ),
    ),
  };
}

/** Sums the `opencode-go` models in one v2 session-statistics response. */
export function parseOpenCodeGoStats(stdout: string): { cost: number; steps: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("OpenCode Go usage statistics were not valid JSON");
  }
  const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
  const models = isRecord(data) && Array.isArray(data.models) ? data.models : null;
  if (!models) throw new Error("OpenCode Go usage statistics had no model breakdown");
  let cost = 0;
  let steps = 0;
  for (const entry of models) {
    if (!isRecord(entry) || !isRecord(entry.model) || entry.model.providerID !== "opencode-go") {
      continue;
    }
    cost += finiteNumber(entry.cost) ?? 0;
    steps += finiteNumber(entry.steps) ?? 0;
  }
  return { cost, steps };
}

/** Normalizes one aggregate row returned by `opencode db --format json`. */
export function parseOpenCodeGoUsage(stdout: string): UsageLimitsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("OpenCode Go usage query returned invalid JSON");
  }
  const row = Array.isArray(parsed) ? parsed[0] : null;
  if (!isRecord(row)) {
    throw new Error("OpenCode Go usage query returned no aggregate row");
  }
  const messageCount = finiteNumber(row.messageCount);
  if (messageCount === null) {
    throw new Error("OpenCode Go usage query returned a malformed message count");
  }
  if (messageCount === 0) return NO_USAGE;

  const observedAt = requiredNumber(row.observedAt, "observation time");
  const limits: UsageLimit[] = [
    usageLimit(
      "rolling",
      "5-hour limit",
      row.rollingUsed,
      GO_LIMITS.rolling,
      row.rollingResetsAt,
      observedAt,
    ),
    usageLimit(
      "weekly",
      "Weekly limit",
      row.weeklyUsed,
      GO_LIMITS.weekly,
      row.weeklyResetsAt,
      observedAt,
    ),
    usageLimit(
      "monthly",
      "Monthly limit",
      row.monthlyUsed,
      GO_LIMITS.monthly,
      row.monthlyResetsAt,
      observedAt,
    ),
  ];
  return { status: "ready", observedAt, limits };
}

function usageLimit(
  id: string,
  title: string,
  usedValue: unknown,
  limit: number,
  resetsAtValue: unknown,
  observedAt: number,
): UsageLimit {
  const used = requiredNumber(usedValue, `${title} usage`);
  const resetsAt = finiteNumber(resetsAtValue);
  return {
    id,
    title,
    used: Math.max(0, used),
    limit,
    ...(resetsAt === null ? {} : { resetsInMs: Math.max(0, resetsAt - observedAt) }),
  };
}

function requiredNumber(value: unknown, field: string): number {
  const number = finiteNumber(value);
  if (number === null) {
    throw new Error(`OpenCode Go usage query returned malformed ${field}`);
  }
  return number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
