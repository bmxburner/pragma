import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minimize2, Minus, MousePointer2, Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";

import type { ComputerScreenshot, ComputerSession } from "@pragma-sh/constants";

import { IconButton } from "@/components/ui/icon-button";
import { errorMessage } from "@/lib/errors";
import { computerRpc } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  minimizeComputerPip,
  revealComputerPip,
  useComputerPipMinimized,
} from "@/state/computer-pip-store";
import {
  controlledApps,
  controlSession,
  useComputerUse,
  type ComputerCursor,
} from "@/state/computer-use-store";

/** Frame refresh while the panel is visible. */
const FRAME_INTERVAL_MS = 500;
/** How much the expanded view zooms in around the agent cursor. */
const FOLLOW_ZOOM = 2;
/** Panel sizes in CSS pixels. */
const COMPACT = { width: 320, height: 236 };
const EXPANDED = { width: 720, height: 480 };
/** Distance kept from the window edges. */
const MARGIN = 16;

/**
 * The in-app picture-in-picture panel for the selected worktree's
 * computer-use sessions: a live view of the app an agent is driving, who is
 * driving it, what it is doing, and the controls to pause or stop it.
 *
 * It floats inside the Pragma window only — never as a separate OS window —
 * and can be dragged anywhere in it by its header. Minimize collapses it to a
 * pill (the sidebar badge brings it back); Expand enlarges it and zooms the
 * view onto the agent cursor, following it as it moves.
 */
export function ComputerPip({ sessions }: { sessions: ComputerSession[] }) {
  const { cursors } = useComputerUse();
  const minimized = useComputerPipMinimized();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  const cursor = session ? cursors[session.id] : undefined;
  const [expanded, setExpanded] = useState(false);
  const size = expanded ? EXPANDED : COMPACT;
  const { position, startDrag } = useDraggable(size);
  const frame = useFrame(
    minimized ? null : (session?.id ?? null),
    expanded ? 1280 : 480,
    cursor?.pulses ?? 0,
  );

  if (!session) return null;
  if (minimized) {
    return (
      <button
        className="fixed right-4 bottom-4 z-50 flex max-w-72 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs shadow-lg"
        data-testid="computer-pip-pill"
        onClick={revealComputerPip}
        type="button"
      >
        <MousePointer2 className="size-3.5 shrink-0 animate-pulse text-primary" />
        <span className="truncate">
          {session.owner.label ?? "Agent"} · {controlledApps(session)}
        </span>
      </button>
    );
  }

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-2xl transition-[width,height] duration-200"
      data-testid="computer-pip"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <PipHeader
        expanded={expanded}
        onExpand={() => setExpanded((value) => !value)}
        onPointerDown={startDrag}
        session={session}
        sessions={sessions}
        setSelectedId={setSelectedId}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted">
        {frame ? (
          <PipFrame cursor={cursor} follow={expanded} frame={frame} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Waiting for the first frame…
          </div>
        )}
        {session.paused ? (
          <div className="absolute inset-x-0 bottom-0 bg-warning/90 px-3 py-1 text-center text-xs font-medium text-background">
            Paused — you're in control
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs">
        <MousePointer2 className="size-3 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">
          {cursor?.description ?? session.lastDescription ?? "Idle"}
        </span>
        <span className="shrink-0 text-muted-foreground">{session.actionCount} steps</span>
      </div>
    </div>
  );
}

/**
 * Keeps the panel inside the window: it starts in the bottom-right corner,
 * follows the pointer while its header is dragged, and is clamped back in
 * whenever its size or the window changes.
 */
function useDraggable(size: { width: number; height: number }) {
  const [position, setPosition] = useState(() => cornerPosition(size));
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const clamp = () => setPosition((current) => clampPosition(current, size));
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [size]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
    const move = (moveEvent: PointerEvent) => {
      const offset = drag.current;
      if (!offset) return;
      setPosition(
        clampPosition({ x: moveEvent.clientX - offset.dx, y: moveEvent.clientY - offset.dy }, size),
      );
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { position, startDrag };
}

function cornerPosition(size: { width: number; height: number }) {
  return clampPosition(
    { x: window.innerWidth - size.width - MARGIN, y: window.innerHeight - size.height - MARGIN },
    size,
  );
}

/** Keeps a panel of `size` at `point` fully inside the window. */
export function clampPosition(
  point: { x: number; y: number },
  size: { width: number; height: number },
  bounds = { width: window.innerWidth, height: window.innerHeight },
): { x: number; y: number } {
  const maxX = Math.max(MARGIN, bounds.width - size.width - MARGIN);
  const maxY = Math.max(MARGIN, bounds.height - size.height - MARGIN);
  return {
    x: Math.min(Math.max(point.x, MARGIN), maxX),
    y: Math.min(Math.max(point.y, MARGIN), maxY),
  };
}

function PipHeader({
  expanded,
  onExpand,
  onPointerDown,
  session,
  sessions,
  setSelectedId,
}: {
  expanded: boolean;
  onExpand: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  session: ComputerSession;
  sessions: ComputerSession[];
  setSelectedId: (id: string) => void;
}) {
  const run = (op: "pause" | "unpause" | "stop") => {
    void controlSession(op, session.id).catch((error: unknown) => toast.error(errorMessage(error)));
  };
  return (
    <div
      className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1 border-b px-2 select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
    >
      <div className="min-w-0 flex-1 truncate text-xs">
        {sessions.length > 1 ? (
          <span className="flex gap-1">
            {sessions.map((s) => (
              <button
                className={cn(
                  "truncate rounded px-1.5 py-0.5",
                  s.id === session.id ? "bg-muted font-medium" : "text-muted-foreground",
                )}
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                type="button"
              >
                {s.owner.label ?? "Agent"}
              </button>
            ))}
          </span>
        ) : (
          <span>
            <span className="font-medium">{session.owner.label ?? "Agent"}</span>
            <span className="text-muted-foreground"> · {controlledApps(session)}</span>
          </span>
        )}
      </div>
      {session.paused ? (
        <IconButton label="Resume" onClick={() => run("unpause")} size="icon-xs" variant="ghost">
          <Play />
        </IconButton>
      ) : (
        <IconButton label="Pause" onClick={() => run("pause")} size="icon-xs" variant="ghost">
          <Pause />
        </IconButton>
      )}
      <IconButton
        className="text-destructive"
        label="Stop"
        onClick={() => run("stop")}
        size="icon-xs"
        variant="ghost"
      >
        <Square />
      </IconButton>
      <IconButton
        label={expanded ? "Shrink" : "Expand to cursor"}
        onClick={onExpand}
        size="icon-xs"
        variant="ghost"
      >
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </IconButton>
      <IconButton label="Minimize" onClick={minimizeComputerPip} size="icon-xs" variant="ghost">
        <Minus />
      </IconButton>
    </div>
  );
}

/**
 * The live frame, with the agent cursor drawn where it is. Expanded, the view
 * zooms in and keeps the cursor centred, so it follows the agent around.
 */
function PipFrame({
  cursor,
  follow,
  frame,
}: {
  cursor: ComputerCursor | undefined;
  follow: boolean;
  frame: ComputerScreenshot;
}) {
  const position = cursor ? cursorInFrame(cursor, frame) : null;
  const zoom = follow && position ? FOLLOW_ZOOM : 1;
  return (
    <div className="relative h-full w-full">
      <div
        className="absolute inset-0 transition-transform duration-300"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: position ? `${position.left}% ${position.top}%` : "center",
        }}
      >
        <img
          alt="What the agent sees"
          className="h-full w-full object-contain"
          src={`data:image/${frame.format};base64,${frame.base64 ?? ""}`}
        />
        {position ? (
          <MousePointer2
            className="absolute size-4 fill-primary text-primary-foreground drop-shadow"
            style={{ left: `${position.left}%`, top: `${position.top}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Where a screen-space cursor falls in a frame, as percentages of its size. */
export function cursorInFrame(
  cursor: Pick<ComputerCursor, "point">,
  frame: Pick<ComputerScreenshot, "origin" | "scale" | "width" | "height">,
): { left: number; top: number } | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const left = (((cursor.point.x - frame.origin.x) * frame.scale) / frame.width) * 100;
  const top = (((cursor.point.y - frame.origin.y) * frame.scale) / frame.height) * 100;
  if (left < 0 || top < 0 || left > 100 || top > 100) return null;
  return { left, top };
}

/** Polls the session's frame while the window is visible, and right after each action. */
function useFrame(sessionId: string | null, maxWidth: number, pulses: number) {
  const [frame, setFrame] = useState<ComputerScreenshot | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setFrame(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const pull = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await computerRpc<ComputerScreenshot>({
          op: "frame",
          session: sessionId,
          maxWidth,
        });
        if (!cancelled) setFrame(next);
      } catch {
        // No frame yet (the session has no app, or capture is not allowed).
      } finally {
        inFlight = false;
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), FRAME_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, maxWidth, pulses]);
  return frame;
}
