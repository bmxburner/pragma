import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, Minus, MousePointer2, Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";

import type { ComputerScreenshot, ComputerSession } from "@pragma-sh/constants";

import { NO_WORKTREE_PIP } from "@/components/computer-use/ComputerUseController";
import { IconButton } from "@/components/ui/icon-button";
import { errorMessage } from "@/lib/errors";
import { computerPipExpand, computerRpc } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  controlledApps,
  controlSession,
  useComputerUse,
  type ComputerCursor,
} from "@/state/computer-use-store";

/** Frame refresh while the window is visible. */
const FRAME_INTERVAL_MS = 500;
/** How much the expanded view zooms in around the agent cursor. */
const FOLLOW_ZOOM = 2;

/**
 * The picture-in-picture window for one worktree's computer-use session: a
 * live view of the app the agent is driving, who is driving it, what it is
 * doing, and the controls to pause or stop it.
 *
 * The window is always on top and draggable by its header. Minimize sends it
 * to the Dock; Expand grows it onto the display the agent cursor is on and
 * follows the cursor, zoomed in, so the user can see exactly where the agent
 * is working. It is excluded from screen capture, so it never shows up in
 * what an agent reads back.
 */
export function ComputerPip({ worktreeId }: { worktreeId: string }) {
  const { snapshot, cursors } = useComputerUse();
  const sessions = (snapshot?.sessions ?? []).filter((session) =>
    worktreeId === NO_WORKTREE_PIP ? !session.worktreeId : session.worktreeId === worktreeId,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  const cursor = session ? cursors[session.id] : undefined;
  const [expanded, setExpanded] = useState(false);
  const frame = useFrame(session?.id ?? null, expanded ? 1280 : 480, cursor?.pulses ?? 0);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    const point = cursor ? ([cursor.point.x, cursor.point.y] as [number, number]) : null;
    void computerPipExpand(worktreeId, next, point).catch((error: unknown) =>
      toast.error(errorMessage(error)),
    );
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border bg-background text-foreground">
      <PipHeader
        expanded={expanded}
        onExpand={toggleExpanded}
        session={session}
        sessions={sessions}
        setSelectedId={setSelectedId}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted">
        {frame ? (
          <PipFrame cursor={cursor} follow={expanded} frame={frame} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {session ? "Waiting for the first frame…" : "No agent is using the computer."}
          </div>
        )}
        {session?.paused ? (
          <div className="absolute inset-x-0 bottom-0 bg-warning/90 px-3 py-1 text-center text-xs font-medium text-background">
            Paused — you're in control
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs">
        <MousePointer2 className="size-3 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">
          {cursor?.description ?? session?.lastDescription ?? "Idle"}
        </span>
        {session ? (
          <span className="shrink-0 text-muted-foreground">{session.actionCount} steps</span>
        ) : null}
      </div>
    </div>
  );
}

function PipHeader({
  expanded,
  onExpand,
  session,
  sessions,
  setSelectedId,
}: {
  expanded: boolean;
  onExpand: () => void;
  session: ComputerSession | null;
  sessions: ComputerSession[];
  setSelectedId: (id: string) => void;
}) {
  const run = (op: "pause" | "unpause" | "stop") => {
    if (!session) return;
    void controlSession(op, session.id).catch((error: unknown) => toast.error(errorMessage(error)));
  };
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2" data-tauri-drag-region>
      <div className="min-w-0 flex-1 truncate text-xs" data-tauri-drag-region>
        {sessions.length > 1 ? (
          <span className="flex gap-1">
            {sessions.map((s) => (
              <button
                className={cn(
                  "truncate rounded px-1.5 py-0.5",
                  s.id === session?.id ? "bg-muted font-medium" : "text-muted-foreground",
                )}
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                type="button"
              >
                {s.owner.label ?? "Agent"}
              </button>
            ))}
          </span>
        ) : session ? (
          <span data-tauri-drag-region>
            <span className="font-medium">{session.owner.label ?? "Agent"}</span>
            <span className="text-muted-foreground"> · {controlledApps(session)}</span>
          </span>
        ) : null}
      </div>
      {session?.paused ? (
        <IconButton label="Resume" onClick={() => run("unpause")} size="icon-xs" variant="ghost">
          <Play />
        </IconButton>
      ) : (
        <IconButton
          disabled={!session}
          label="Pause"
          onClick={() => run("pause")}
          size="icon-xs"
          variant="ghost"
        >
          <Pause />
        </IconButton>
      )}
      <IconButton
        className="text-destructive"
        disabled={!session}
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
      <IconButton
        label="Minimize"
        onClick={() => void getCurrentWindow().minimize()}
        size="icon-xs"
        variant="ghost"
      >
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
