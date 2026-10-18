import { type KeyboardEvent, type MouseEvent, useCallback } from "react";

import { GitBranch, Loader2, Trash2 } from "lucide-react";

import type { Fanout, KanbanCompletedAction, KanbanPromptCard } from "@pragma-sh/constants";
import { splitPromptContext } from "@pragma-sh/plugin/catalog";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import { AgentIcon } from "@/components/agents/AgentIcon";
import { IconButton } from "@/components/ui/icon-button";
import type { AgentConfig } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useTabAgentStatus } from "@/state/agent-status-store";
import { BoardAgentProgress } from "@/components/kanban/BoardAgentProgress";
import { memberLabel } from "@/lib/fanout";
import type { BoardAttempt, BoardCard, BoardPreferences } from "@/lib/kanban-model";

const COMPLETING_BADGE_CLASS = "bg-warning/15 text-warning";
const PR_BADGE_CLASS = "bg-skill/15 text-skill";
const MERGED_BADGE_CLASS = "bg-success/15 text-success";

interface KanbanCardProps {
  card: BoardCard;
  category?: BoardPreferences["categories"][number];
  /** Agent launcher config resolved from the card's agentId. */
  agent: AgentConfig | null;
  /** The background completion action running on this card, if any. */
  completingAction?: KanbanCompletedAction | null;
  /** Opens a draft for editing. */
  onEdit: (card: KanbanPromptCard) => void;
  onOpen: (card: KanbanPromptCard) => void;
  onDelete: (card: KanbanPromptCard) => void;
}

/** Label shown while a background completion action is running. */
function completingBadgeLabel(action: KanbanCompletedAction): string {
  return action === "commitMerge" ? "Merging…" : "Opening PR…";
}

type CompletedBadge = { label: string; className: string; spinning: boolean };

/** The status badge for a completed card (merging/PR/merged), or null. */
function completedBadge(
  card: KanbanPromptCard,
  completingAction: KanbanCompletedAction | null,
): CompletedBadge | null {
  if (completingAction) {
    return {
      label: completingBadgeLabel(completingAction),
      className: COMPLETING_BADGE_CLASS,
      spinning: true,
    };
  }
  if (card.pullRequestUrl || card.pullRequestNumber) {
    return {
      label: card.pullRequestNumber ? `PR #${card.pullRequestNumber}` : "PR",
      className: PR_BADGE_CLASS,
      spinning: false,
    };
  }
  if (card.completedAction === "commitMerge") {
    return { label: "Merged", className: MERGED_BADGE_CLASS, spinning: false };
  }
  return null;
}

/** A small colored status badge in the card header. */
function KanbanCardBadge({ badge }: { badge: CompletedBadge }) {
  return (
    <span
      className={cn(
        "ml-auto shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium",
        badge.className,
        badge.spinning && "flex items-center gap-1",
      )}
    >
      {badge.spinning ? <Loader2 className="size-3 animate-spin" /> : null}
      {badge.label}
    </span>
  );
}

/** The card footer: agent icon + model, and the hover-revealed delete button. */
function KanbanCardFooter({
  card,
  displayAgent,
  onDelete,
}: {
  card: KanbanPromptCard;
  displayAgent: AgentConfig;
  onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-flex shrink-0"
          title={displayAgent.name}
          aria-label={`Agent: ${displayAgent.name}`}
        >
          <AgentIcon agent={displayAgent} />
        </span>
        {card.modelId ? (
          <span className="truncate" title={card.modelId}>
            {card.modelId}
          </span>
        ) : null}
      </div>
      <IconButton
        className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/item:opacity-100 focus-visible:opacity-100 hover:text-destructive"
        label="Delete card"
        size="icon-sm"
        variant="ghost"
        onClick={onDelete}
      >
        <Trash2 />
      </IconButton>
    </div>
  );
}

function KanbanCardHeader({
  card,
  agentStatus,
  badge,
}: {
  card: KanbanPromptCard;
  agentStatus: ReturnType<typeof useTabAgentStatus>;
  badge: CompletedBadge | null;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <GitBranch className="size-3.5 shrink-0" />
      <span className="truncate font-medium text-foreground">{card.branchName}</span>
      {card.status === "inProgress" ? (
        card.worktreeId ? (
          <span className="ml-auto">
            <BoardAgentProgress worktreeId={card.worktreeId} iconOnly />
          </span>
        ) : (
          <AgentStatusDot status={agentStatus} className="ml-auto" />
        )
      ) : null}
      {badge ? <KanbanCardBadge badge={badge} /> : null}
    </div>
  );
}

function KanbanCardCategory({ category }: { category: NonNullable<KanbanCardProps["category"]> }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: category.color }}>
      <span className="size-2 rounded-full" style={{ backgroundColor: category.color }} />
      {category.name}
    </span>
  );
}

function KanbanCardAttempts({ attempts }: { attempts: BoardAttempt[] }) {
  return (
    <div className="space-y-1 border-l-2 border-border pl-2">
      {attempts.map((attempt) => (
        <div key={attempt.key} className="rounded border border-border p-2 text-xs">
          {attempt.selector} · {attempt.modelId ?? "Default model"}
          {attempt.reasoningId ? ` · ${attempt.reasoningId}` : ""}
        </div>
      ))}
    </div>
  );
}

function KanbanCardFanout({
  card,
  fanout,
  onOpen,
}: {
  card: BoardCard;
  fanout: Fanout;
  onOpen: KanbanCardProps["onOpen"];
}) {
  return (
    <div className="space-y-2 border-l-2 border-border pl-2">
      {fanout.members.map((member) => (
        <button
          type="button"
          key={member.id}
          disabled={!member.worktreeId}
          onClick={(event) => {
            event.stopPropagation();
            if (member.worktreeId)
              onOpen({ ...card, worktreeId: member.worktreeId, agentTabId: member.tabId });
          }}
          className="block w-full rounded border border-border bg-background/40 p-2 text-left text-xs hover:bg-accent"
        >
          <div className="truncate">
            {memberLabel(member)} · {member.status}
          </div>
          {member.worktreeId ? <BoardAgentProgress worktreeId={member.worktreeId} /> : null}
        </button>
      ))}
    </div>
  );
}

function KanbanCardProgress({ card, onOpen }: Pick<KanbanCardProps, "card" | "onOpen">) {
  if (card.fanout) return <KanbanCardFanout card={card} fanout={card.fanout} onOpen={onOpen} />;
  if (card.worktreeId) return <BoardAgentProgress worktreeId={card.worktreeId} />;
  return null;
}

function fallbackAgent(card: BoardCard): AgentConfig {
  return { id: card.agentId, name: card.agentId, iconDataUrl: null, start: [] };
}

/**
 * One prompt card. Its affordances are status-driven and enforce the allowed
 * transitions: drafts open their editor, in-progress cards open their session (and show
 * live agent status), review cards expose Merge/PR completion buttons, completed
 * cards show their merge/PR outcome (or a live "Merging…"/"Opening PR…" badge
 * while the background job runs).
 */
export function KanbanCard({
  card,
  agent,
  completingAction,
  onEdit,
  onOpen,
  onDelete,
  category,
}: KanbanCardProps) {
  // Only in-progress cards have a live agent session to reflect.
  const agentStatus = useTabAgentStatus(
    card.status === "inProgress" ? (card.agentTabId ?? null) : null,
  );

  // Draft cards open their editor; started cards open their worktree/session.
  const handleActivate = useCallback(() => {
    if (card.status === "draft") {
      onEdit(card);
      return;
    }
    onOpen(card);
  }, [card, onEdit, onOpen]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter") handleActivate();
    },
    [handleActivate],
  );
  const handleDelete = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onDelete(card);
    },
    [onDelete, card],
  );

  const badge = completedBadge(card, completingAction ?? null);
  const draftAttempts = card.status === "draft" ? card.attempts : undefined;

  return (
    <div
      className="cursor-pointer space-y-2 rounded-lg border border-border bg-card p-3 shadow-sm"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the card nests its own buttons (delete, fanout members), which a <button> cannot contain.
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
    >
      <KanbanCardHeader card={card} agentStatus={agentStatus} badge={badge} />
      {category ? <KanbanCardCategory category={category} /> : null}

      <p className="line-clamp-3 whitespace-pre-wrap text-sm">
        {splitPromptContext(card.prompt).prompt.trim() || "No prompt"}
      </p>
      {draftAttempts?.length ? <KanbanCardAttempts attempts={draftAttempts} /> : null}
      <KanbanCardProgress card={card} onOpen={onOpen} />

      <KanbanCardFooter
        card={card}
        displayAgent={agent ?? fallbackAgent(card)}
        onDelete={handleDelete}
      />
    </div>
  );
}
