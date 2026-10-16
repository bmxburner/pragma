import { describe, expect, it } from "vitest";

import { whiteboardRetryDelay } from "./whiteboard-retry";

describe("whiteboardRetryDelay", () => {
  it("doubles from the poll interval and caps at a minute", () => {
    expect([1, 2, 3, 4, 5, 6].map((failures) => whiteboardRetryDelay(failures, 3000))).toEqual([
      6000, 12_000, 24_000, 48_000, 60_000, 60_000,
    ]);
  });

  it("never retries faster than the one-second poll floor", () => {
    expect(whiteboardRetryDelay(1, 0)).toBe(2000);
  });
});
