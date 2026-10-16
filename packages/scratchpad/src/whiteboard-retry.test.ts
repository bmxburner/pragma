import { describe, expect, it } from "vitest";

import { WhiteboardRetryGate, whiteboardRetryDelay } from "./whiteboard-retry";

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

describe("WhiteboardRetryGate", () => {
  it("holds automatic polls back after a failure until the delay passes", () => {
    const gate = new WhiteboardRetryGate(3000);
    expect(gate.allows(false, 0)).toBe(true);
    gate.failed(0);
    expect(gate.allows(false, 5999)).toBe(false);
    expect(gate.allows(false, 6000)).toBe(true);
  });

  it("lets a manual refresh through and resets after a success", () => {
    const gate = new WhiteboardRetryGate(3000);
    gate.failed(0);
    gate.failed(0);
    expect(gate.allows(true, 1)).toBe(true);
    gate.succeeded();
    expect(gate.allows(false, 1)).toBe(true);
  });
});
