import { describe, expect, it } from "vitest";

import { clampPosition, cursorInFrame } from "@/components/computer-use/ComputerPip";

describe("clampPosition", () => {
  const size = { width: 320, height: 236 };
  const bounds = { width: 1200, height: 800 };

  it("keeps the panel inside the window", () => {
    expect(clampPosition({ x: -50, y: -50 }, size, bounds)).toEqual({ x: 16, y: 16 });
    expect(clampPosition({ x: 5000, y: 5000 }, size, bounds)).toEqual({ x: 864, y: 548 });
    expect(clampPosition({ x: 100, y: 200 }, size, bounds)).toEqual({ x: 100, y: 200 });
  });

  it("pins to the margin when the window is smaller than the panel", () => {
    expect(clampPosition({ x: 100, y: 100 }, size, { width: 200, height: 100 })).toEqual({
      x: 16,
      y: 16,
    });
  });
});

describe("cursorInFrame", () => {
  const frame = { origin: { x: 100, y: 50 }, scale: 2, width: 400, height: 200 };

  it("maps a screen point to percentages of the frame", () => {
    expect(cursorInFrame({ point: { x: 200, y: 100 } }, frame)).toEqual({ left: 50, top: 50 });
  });

  it("returns null for a cursor outside the frame", () => {
    expect(cursorInFrame({ point: { x: 10, y: 10 } }, frame)).toBeNull();
    expect(cursorInFrame({ point: { x: 200, y: 100 } }, { ...frame, width: 0 })).toBeNull();
  });
});
