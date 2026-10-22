import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";

import { constants, type ComputerSession } from "@pragma-sh/constants";

import { useComputerUse, type ComputerCursor } from "@/state/computer-use-store";

/** How long the agent cursor glides to its next point: the host waits this long. */
const GLIDE_MS = constants.computer.cursorLeadMs;

/**
 * The agent cursor, drawn on a transparent, click-through window covering one
 * display. It is deliberately not the system cursor: a coloured arrow with the
 * agent's name and what it is about to do, gliding to each target just before
 * the host acts, with a ripple when the action lands. Element actions never
 * move the real pointer, so this is often the only pointer that moves.
 */
export function CursorOverlay({ origin }: { origin: { x: number; y: number } }) {
  const { snapshot, cursors } = useComputerUse();
  useEffect(() => {
    // The overlay must never paint a background over the user's screen.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);
  const sessions = snapshot?.sessions ?? [];
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      {sessions.map((session) => {
        const cursor = cursors[session.id];
        return cursor ? (
          <AgentCursor cursor={cursor} key={session.id} origin={origin} session={session} />
        ) : null;
      })}
    </div>
  );
}

function AgentCursor({
  cursor,
  origin,
  session,
}: {
  cursor: ComputerCursor;
  origin: { x: number; y: number };
  session: ComputerSession;
}) {
  const x = cursor.point.x - origin.x;
  const y = cursor.point.y - origin.y;
  const ripple = useRipple(cursor.pulses);
  // A cursor on another display has negative or out-of-bounds coordinates
  // here and is simply clipped by `overflow-hidden`.
  return (
    <div
      className="absolute top-0 left-0"
      data-testid="agent-cursor"
      style={{
        transform: `translate(${x}px, ${y}px)`,
        transition: `transform ${GLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
      }}
    >
      {ripple ? (
        <span
          className="absolute -top-4 -left-4 size-8 animate-ping rounded-full bg-primary/40"
          key={ripple}
        />
      ) : null}
      <MousePointer2
        className="size-6 fill-primary text-primary-foreground drop-shadow-md"
        strokeWidth={1.5}
      />
      <div className="mt-1 ml-4 max-w-72 truncate rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground shadow-md">
        {session.owner.label ?? "Agent"}
        {cursor.description ? `: ${cursor.description}` : ""}
      </div>
    </div>
  );
}

/** A key that changes on each new pulse and clears itself after the ripple. */
function useRipple(pulses: number): number | null {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    if (pulses === 0) return;
    setActive(pulses);
    const timer = window.setTimeout(() => setActive(null), 600);
    return () => window.clearTimeout(timer);
  }, [pulses]);
  return active;
}
