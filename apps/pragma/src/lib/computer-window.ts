/**
 * Whether this webview is a computer-use cursor overlay, from its URL fragment.
 *
 * `src-tauri/src/computer.rs` opens the same bundle in one transparent,
 * click-through window per display and says so in the fragment:
 * `computer-overlay=<displayId>&x=<x>&y=<y>`, where the origin is the
 * display's top-left in screen points.
 */
export interface ComputerOverlayRoute {
  kind: "overlay";
  displayId: string;
  origin: { x: number; y: number };
}

/** Parses a fragment (with or without its leading `#`). */
export function parseComputerWindowRoute(hash: string): ComputerOverlayRoute | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const overlay = params.get("computer-overlay");
  if (!overlay) return null;
  const x = Number(params.get("x") ?? 0);
  const y = Number(params.get("y") ?? 0);
  return {
    kind: "overlay",
    displayId: overlay,
    origin: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 },
  };
}
