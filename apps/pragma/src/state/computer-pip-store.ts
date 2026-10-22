import { useSyncExternalStore } from "react";

/**
 * Whether the in-app computer-use panel is minimized to its pill. Shared so
 * the sidebar's computer-use badge can bring the panel back from anywhere.
 */
let minimized = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === minimized) return;
  minimized = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Minimizes the panel to its pill. */
export function minimizeComputerPip(): void {
  set(true);
}

/** Shows the full panel again. */
export function revealComputerPip(): void {
  set(false);
}

/** Whether the panel is minimized. */
export function useComputerPipMinimized(): boolean {
  return useSyncExternalStore(subscribe, () => minimized);
}
