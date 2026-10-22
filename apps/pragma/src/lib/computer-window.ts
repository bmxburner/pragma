/**
 * Which computer-use window this webview is, from its URL fragment.
 *
 * `src-tauri/src/computer.rs` opens the same bundle in two extra kinds of
 * window and says which in the fragment: `computer-pip=<worktreeId>` for a
 * picture-in-picture window, `computer-overlay=<displayId>&x=<x>&y=<y>` for a
 * per-display cursor overlay, whose origin is the display's top-left in
 * screen points.
 */
export type ComputerWindowRoute =
  | { kind: "pip"; worktreeId: string }
  | { kind: "overlay"; displayId: string; origin: { x: number; y: number } };

/** Parses a fragment (with or without its leading `#`). */
export function parseComputerWindowRoute(hash: string): ComputerWindowRoute | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const pip = params.get("computer-pip");
  if (pip) return { kind: "pip", worktreeId: pip };
  const overlay = params.get("computer-overlay");
  if (overlay) {
    const x = Number(params.get("x") ?? 0);
    const y = Number(params.get("y") ?? 0);
    return {
      kind: "overlay",
      displayId: overlay,
      origin: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 },
    };
  }
  return null;
}
