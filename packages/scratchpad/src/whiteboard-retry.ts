/** Longest a failing whiteboard embed waits between automatic retries. */
const WHITEBOARD_MAX_RETRY_MS = 60_000;

/**
 * Exponential backoff for a whiteboard embed whose snapshot keeps failing:
 * twice the poll interval after the first failure, doubling up to a minute.
 */
export function whiteboardRetryDelay(failures: number, refreshIntervalMs: number): number {
  const base = Math.max(1000, refreshIntervalMs);
  return Math.min(WHITEBOARD_MAX_RETRY_MS, base * 2 ** Math.min(failures, 10));
}

/**
 * Decides whether a whiteboard embed may poll again. A board that cannot
 * render has no known version, so without this every poll tick asks the host
 * for another full render. A manual refresh always goes through.
 */
export class WhiteboardRetryGate {
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly refreshIntervalMs: number) {}

  /** Whether a poll may run now; `manual` refreshes skip the backoff. */
  allows(manual: boolean, now: number = Date.now()): boolean {
    return manual || now >= this.retryAt;
  }

  /** Clears the backoff after a snapshot arrives. */
  succeeded(): void {
    this.failures = 0;
    this.retryAt = 0;
  }

  /** Pushes the next automatic poll out after a failed snapshot. */
  failed(now: number = Date.now()): void {
    this.failures += 1;
    this.retryAt = now + whiteboardRetryDelay(this.failures, this.refreshIntervalMs);
  }
}
