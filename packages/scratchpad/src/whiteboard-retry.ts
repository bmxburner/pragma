/** Longest a failing whiteboard embed waits between automatic retries. */
const WHITEBOARD_MAX_RETRY_MS = 60_000;

/**
 * Exponential backoff for a whiteboard embed whose snapshot keeps failing:
 * twice the poll interval after the first failure, doubling up to a minute.
 * A board that cannot render has no known version, so without this every poll
 * tick asks the host for another full render.
 */
export function whiteboardRetryDelay(failures: number, refreshIntervalMs: number): number {
  const base = Math.max(1000, refreshIntervalMs);
  return Math.min(WHITEBOARD_MAX_RETRY_MS, base * 2 ** Math.min(failures, 10));
}
