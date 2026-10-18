import { useEffect, useMemo, useState } from "react";

import { GripVertical, Info, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { SUGGESTED_DRAFT_PAGE_SIZE } from "@pragma-sh/plugin/catalog";
import type { KanbanPromptCard, KanbanPromptStatus, Worktree } from "@pragma-sh/constants";

import { KanbanCard } from "@/components/kanban/KanbanCard";
import { KanbanCompletionDialog } from "@/components/kanban/KanbanCompletionDialog";
import { KanbanDeleteDialog } from "@/components/kanban/KanbanDeleteDialog";
import { KanbanDraftDialog, type KanbanDraftSeed } from "@/components/kanban/KanbanDraftDialog";
import { KanbanWorktreeDialog } from "@/components/kanban/KanbanWorktreeDialog";
import { KanbanCategoryMenu } from "@/components/kanban/KanbanCategoryMenu";
import { SuggestedDraftCard } from "@/components/kanban/SuggestedDraftCard";
import { useWorktreePrLifecycles } from "@/hooks/use-worktree-pr-lifecycles";
import { type BoardSuggestion, useSuggestedDrafts } from "@/hooks/use-suggested-drafts";
import { useSuggestedDraftProviders } from "@/plugins/suggested-drafts";
import { useGitHub } from "@/state/github-context";
import { boardCardKey, type BoardCard } from "@/lib/kanban-model";
import { updateBoardPreferences } from "@/state/kanban-preferences";
import { MainBehindAlert } from "@/components/dialogs/MainBehindAlert";
import { IconTooltip } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  type KanbanMoveEvent,
  KanbanOverlay,
} from "@/components/ui/kanban";
import { type BoardMovePlan, planBoardMove } from "@/lib/kanban-board-move";
import { startWindowDrag } from "@/lib/window-drag";
import { type AgentConfig } from "@/lib/tauri";
import { mainBehindRemote, type MainBehindRemote } from "@/lib/worktree-sync";
import { useKanban } from "@/state/kanban-context";
import { useWorkspace } from "@/state/workspace-context";

interface ColumnSpec {
  status: KanbanPromptStatus;
  title: string;
}

const COLUMNS: ColumnSpec[] = [
  { status: "draft", title: "Drafts" },
  { status: "inProgress", title: "In progress" },
  { status: "reviewNeeded", title: "Review needed" },
  { status: "completed", title: "Completed" },
];

// dnd-kit reads a value/onValueChange pair; with `onMove` set the board never
// mutates the map itself, so a no-op setter keeps it fully controlled by cards.
function noop() {}

type DraftDialogState = {
  open: boolean;
  card: KanbanPromptCard | null;
  seed: KanbanDraftSeed | null;
};

const CLOSED_DRAFT_DIALOG: DraftDialogState = { open: false, card: null, seed: null };

type PendingStart = { card: KanbanPromptCard; main: MainBehindRemote };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function findAgent(agents: AgentConfig[], card: KanbanPromptCard): AgentConfig | null {
  return agents.find((agent) => agent.id === card.agentId) ?? null;
}

/** Fanouts, running work, review work, and PRs open the preview dialog. */
function opensPreview(card: BoardCard): boolean {
  return (
    Boolean(card.fanout) ||
    card.status === "inProgress" ||
    card.status === "reviewNeeded" ||
    Boolean(card.pullRequestNumber)
  );
}

/**
 * Groups cards by column. While the completion modal is open for a dragged card,
 * it is shown parked in Completed (it's not persisted there until a completion
 * path runs, so a cancel just drops this override and the card snaps back).
 */
function groupCardsByStatus(
  cards: BoardCard[],
  parkedId: string | null,
): Record<KanbanPromptStatus, BoardCard[]> {
  const groups: Record<KanbanPromptStatus, BoardCard[]> = {
    draft: [],
    inProgress: [],
    reviewNeeded: [],
    completed: [],
  };
  for (const card of cards) {
    groups[card.id === parkedId ? "completed" : card.status].push(card);
  }
  return groups;
}

/** Side effects for each drag plan; the plan itself is pure (`planBoardMove`). */
interface BoardMoveActions {
  start: (card: BoardCard) => Promise<void>;
  move: (card: BoardCard, status: Exclude<KanbanPromptStatus, "draft">) => Promise<void>;
  openCompletion: (card: BoardCard) => void;
  openFanoutCompletion: (card: BoardCard) => void;
}

const BOARD_MOVE_HANDLERS: {
  [Kind in BoardMovePlan["kind"]]: (
    plan: Extract<BoardMovePlan, { kind: Kind }>,
    card: BoardCard,
    actions: BoardMoveActions,
  ) => Promise<void> | void;
} = {
  start: (_plan, card, actions) => actions.start(card),
  move: (plan, card, actions) => actions.move(card, plan.status),
  completionDialog: (_plan, card, actions) => actions.openCompletion(card),
  fanoutCompletion: (_plan, card, actions) => actions.openFanoutCompletion(card),
  blocked: () => {
    toast.info("That move isn't available — use the card's actions to advance it.");
  },
  noop: () => {},
};

function runBoardMove(plan: BoardMovePlan, card: BoardCard, actions: BoardMoveActions) {
  const handler = BOARD_MOVE_HANDLERS[plan.kind] as (
    plan: BoardMovePlan,
    card: BoardCard,
    actions: BoardMoveActions,
  ) => Promise<void> | void;
  return handler(plan, card, actions);
}

/** The project's live cards with saved attempts and polled PR numbers merged in. */
function useBoardCards(projectWorktrees: Worktree[]): BoardCard[] {
  const kanban = useKanban();
  const { authenticated } = useGitHub();
  const { prNumberByWorktreeId } = useWorktreePrLifecycles(projectWorktrees, authenticated);
  return useMemo(
    () =>
      kanban.cards.map((card) => ({
        ...card,
        attempts: kanban.preferences.attempts[card.id],
        pullRequestNumber:
          (card.worktreeId ? prNumberByWorktreeId[card.worktreeId] : null) ??
          card.pullRequestNumber,
      })),
    [kanban.cards, kanban.preferences.attempts, prNumberByWorktreeId],
  );
}

/** Suggested drafts for the Drafts column, paged and filtered against existing work. */
interface BoardSuggestions {
  visible: BoardSuggestion[];
  total: number;
  notices: string[];
  loading: boolean;
  loadMore: () => void;
  dismiss: (key: string) => void;
}

/**
 * Plugin-suggested drafts are proposed against the project's main checkout (the
 * GitHub provider reads its repo ref from there). They render as ghost cards in
 * Drafts; picking one pre-fills the draft dialog and nothing is persisted until save.
 */
function useBoardSuggestions(projectWorktrees: Worktree[]): BoardSuggestions {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const projectId = workspace.selectedProjectId;
  const mainWorktree = projectWorktrees.find((worktree) => worktree.isMain) ?? null;
  const providers = useSuggestedDraftProviders(projectId);
  const { suggestions, notices, loading } = useSuggestedDrafts({
    isOpen: true,
    providers,
    project: workspace.activeProject,
    worktree: mainWorktree,
  });
  const [limit, setLimit] = useState(SUGGESTED_DRAFT_PAGE_SIZE);
  useEffect(() => setLimit(SUGGESTED_DRAFT_PAGE_SIZE), [projectId]);
  const available = useMemo(() => {
    const dismissed = new Set(kanban.preferences.dismissedSuggestions);
    const takenBranches = new Set([
      ...projectWorktrees.map((worktree) => worktree.branch),
      ...kanban.cards.map((card) => card.branchName),
    ]);
    return suggestions.filter(
      (suggestion) =>
        !dismissed.has(suggestion.key) && !takenBranches.has(suggestion.draft.branchName),
    );
  }, [suggestions, projectWorktrees, kanban.cards, kanban.preferences.dismissedSuggestions]);

  /** Hides a suggestion for this project by recording its key in board preferences. */
  function dismiss(key: string) {
    if (!projectId) return;
    void updateBoardPreferences(projectId, (current) => ({
      ...current,
      dismissedSuggestions: current.dismissedSuggestions.includes(key)
        ? current.dismissedSuggestions
        : [...current.dismissedSuggestions, key],
    })).catch((cause) => toast.error(errorMessage(cause)));
  }

  return {
    visible: available.slice(0, limit),
    total: available.length,
    notices,
    loading,
    loadMore: () => setLimit((current) => current + SUGGESTED_DRAFT_PAGE_SIZE),
    dismiss,
  };
}

/** Escape exits the board when no modal is open (modals own their own Escape). */
function useExitBoardOnEscape(anyDialogOpen: boolean, exitBoard: () => void) {
  useEffect(() => {
    if (anyDialogOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      ) {
        exitBoard();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyDialogOpen, exitBoard]);
}

/** Which board modal is open, and for which card. */
function useBoardDialogs() {
  const [inspectedCard, setInspectedCard] = useState<BoardCard | null>(null);
  const [completingFanout, setCompletingFanout] = useState(false);
  const [draftDialog, setDraftDialog] = useState<DraftDialogState>(CLOSED_DRAFT_DIALOG);
  const [completionCard, setCompletionCard] = useState<KanbanPromptCard | null>(null);
  const [deletionCard, setDeletionCard] = useState<KanbanPromptCard | null>(null);
  return {
    inspectedCard,
    setInspectedCard,
    completingFanout,
    setCompletingFanout,
    draftDialog,
    setDraftDialog,
    completionCard,
    setCompletionCard,
    deletionCard,
    setDeletionCard,
  };
}

/**
 * Starts a card, first offering to pull main when the project's main checkout is
 * behind its remote. Failures surface as toasts.
 */
function useCardStarter() {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);

  async function start(card: KanbanPromptCard, syncMainWorktreeId: string | null = null) {
    try {
      await kanban.startCard(card, { syncMainWorktreeId });
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  async function requestStart(card: KanbanPromptCard) {
    try {
      const behindMain = await mainBehindRemote(workspace.worktrees[card.projectId] ?? []);
      if (behindMain) {
        setPendingStart({ card, main: behindMain });
        return;
      }
      await start(card);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  function confirmPendingStart(pullFirst: boolean) {
    const pending = pendingStart;
    setPendingStart(null);
    if (pending) {
      void start(pending.card, pullFirst ? pending.main.id : null);
    }
  }

  return {
    pendingStart,
    requestStart,
    confirmPendingStart,
    cancelPendingStart: () => setPendingStart(null),
  };
}

/**
 * The board takes the full frame (the sidebar is hidden), so its header is the
 * window's top-left chrome: it pads past the macOS traffic lights and doubles as
 * a titlebar drag region.
 */
function BoardHeader({ projectName, onExit }: { projectName: string | null; onExit: () => void }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- native titlebar drag region
    <header
      className="flex items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar px-4 pt-[calc(var(--titlebar-height,0px)+0.75rem)] pb-3"
      onMouseDown={startWindowDrag}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate text-base font-semibold">Agent board</h1>
        {projectName ? (
          <span className="truncate text-sm text-muted-foreground">{projectName}</span>
        ) : null}
      </div>
      <Button size="sm" variant="outline" onClick={onExit}>
        Exit agent board
        <X className="size-3.5" />
      </Button>
    </header>
  );
}

interface BoardCardActions {
  onEditDraft: (card: KanbanPromptCard) => void;
  onInspect: (card: BoardCard) => void;
  onDelete: (card: KanbanPromptCard) => void;
}

/** One draggable card with its drag handle and category context menu. */
function BoardCardItem({
  card,
  onEditDraft,
  onInspect,
  onDelete,
}: { card: BoardCard } & BoardCardActions) {
  const kanban = useKanban();
  const { categories, assignments } = kanban.preferences;
  return (
    <KanbanItem
      value={card.id}
      disabled={kanban.preferencesLoading}
      className="group/item flex items-stretch gap-1"
    >
      <IconTooltip label="Drag card">
        <KanbanItemHandle
          aria-label="Drag card"
          className="flex w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/item:opacity-100"
        >
          <GripVertical className="size-4" />
        </KanbanItemHandle>
      </IconTooltip>
      <KanbanCategoryMenu
        card={card}
        onOpen={() => (card.status === "draft" ? onEditDraft(card) : kanban.openCardWorktree(card))}
        onDelete={() => onDelete(card)}
      >
        <div className="min-w-0 flex-1">
          <KanbanCard
            card={card}
            agent={findAgent(kanban.agents, card)}
            completingAction={kanban.completing[card.id] ?? null}
            onEdit={onEditDraft}
            onOpen={(item) => {
              // Other idle cards (and fanout members) jump straight to their worktree.
              if (item.worktreeId !== card.worktreeId || !opensPreview(card)) {
                kanban.openCardWorktree(item);
                return;
              }
              onInspect(card);
            }}
            category={categories.find(
              (category) => category.id === assignments[boardCardKey(card)],
            )}
            onDelete={onDelete}
          />
        </div>
      </KanbanCategoryMenu>
    </KanbanItem>
  );
}

function hasSuggestionContent(suggestions: BoardSuggestions): boolean {
  return suggestions.visible.length > 0 || suggestions.notices.length > 0 || suggestions.loading;
}

/** Fixed-height action row: New draft above Drafts, an aligned spacer elsewhere. */
function BoardColumnActions({
  isDrafts,
  onNewDraft,
}: {
  isDrafts: boolean;
  onNewDraft: () => void;
}) {
  const kanban = useKanban();
  const workspace = useWorkspace();
  return (
    <div className="mb-2 flex h-8 items-center">
      {isDrafts ? (
        <Button
          size="sm"
          className="w-full"
          disabled={!workspace.selectedProjectId || kanban.preferencesLoading}
          onClick={onNewDraft}
        >
          <Plus className="size-4" />
          New draft
        </Button>
      ) : null}
    </div>
  );
}

function emptyColumnText(isDrafts: boolean, loading: boolean): string {
  return isDrafts && !loading ? "Add a draft to get started." : "Nothing here yet.";
}

interface BoardColumnProps extends BoardCardActions {
  column: ColumnSpec;
  cards: BoardCard[];
  suggestions: BoardSuggestions;
  onNewDraft: () => void;
  onPickSuggestion: (suggestion: BoardSuggestion) => void;
}

/**
 * One status column. Columns stay put (we render no column drag handle, so they
 * can't be dragged) but remain drop targets so cards land in empty columns.
 */
function BoardColumn({
  column,
  cards,
  suggestions,
  onNewDraft,
  onPickSuggestion,
  ...cardActions
}: BoardColumnProps) {
  const kanban = useKanban();
  const isDrafts = column.status === "draft";
  const showEmpty = cards.length === 0 && !(isDrafts && hasSuggestionContent(suggestions));
  return (
    <KanbanColumn value={column.status} className="min-w-0">
      <BoardColumnActions isDrafts={isDrafts} onNewDraft={onNewDraft} />
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-background/40">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">{column.title}</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {cards.length}
          </span>
        </div>
        <KanbanColumnContent
          value={column.status}
          className="min-h-0 flex-1 gap-2 overflow-y-auto p-2"
        >
          {cards.map((card) => (
            <BoardCardItem key={card.id} card={card} {...cardActions} />
          ))}
          {isDrafts ? (
            <DraftSuggestions
              suggestions={suggestions.visible}
              total={suggestions.total}
              notices={suggestions.notices}
              loading={suggestions.loading}
              onPick={onPickSuggestion}
              onDismiss={suggestions.dismiss}
              onLoadMore={suggestions.loadMore}
            />
          ) : null}
          {showEmpty ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              {emptyColumnText(isDrafts, kanban.loading)}
            </p>
          ) : null}
        </KanbanColumnContent>
      </div>
    </KanbanColumn>
  );
}

/** The card shown under the pointer while dragging. */
function BoardDragOverlay() {
  const kanban = useKanban();
  return (
    <KanbanOverlay>
      {({ value }) => {
        const card = kanban.cards.find((item) => item.id === String(value));
        if (!card) {
          return null;
        }
        return (
          <div className="w-72 pl-6">
            <KanbanCard
              card={card}
              agent={findAgent(kanban.agents, card)}
              completingAction={kanban.completing[card.id] ?? null}
              onEdit={noop}
              onOpen={noop}
              onDelete={noop}
            />
          </div>
        );
      }}
    </KanbanOverlay>
  );
}

function seedFromSuggestion(suggestion: BoardSuggestion): KanbanDraftSeed {
  return {
    branchName: suggestion.draft.branchName,
    prompt: suggestion.draft.prompt,
    agentId: suggestion.draft.agentId ?? null,
  };
}

/**
 * Full-shell agent board for the selected project. Renders four status columns
 * of persisted cards with drag-and-drop between columns and hosts the draft and
 * completion modals. A card dropped into a new column is routed through the same
 * transition the per-card buttons use (start, mark review, complete); reorders
 * within a column and unsupported drops are ignored. The board is left by
 * selecting a worktree in the sidebar (or Escape); card-driven navigation is what
 * leaves a "Back to agent board" control in the normal shell.
 */
export function ProjectKanbanWorkspace() {
  const kanban = useKanban();
  const workspace = useWorkspace();
  const projectWorktrees = useMemo(
    () =>
      workspace.selectedProjectId ? (workspace.worktrees[workspace.selectedProjectId] ?? []) : [],
    [workspace.selectedProjectId, workspace.worktrees],
  );
  const boardCards = useBoardCards(projectWorktrees);
  const suggestions = useBoardSuggestions(projectWorktrees);
  const {
    inspectedCard,
    setInspectedCard,
    completingFanout,
    setCompletingFanout,
    draftDialog,
    setDraftDialog,
    completionCard,
    setCompletionCard,
    deletionCard,
    setDeletionCard,
  } = useBoardDialogs();
  const { pendingStart, requestStart, confirmPendingStart, cancelPendingStart } = useCardStarter();

  const cardsByStatus = useMemo(
    () => groupCardsByStatus(boardCards, completionCard?.id ?? null),
    [boardCards, completionCard],
  );

  useExitBoardOnEscape(
    [draftDialog.open, completionCard, deletionCard, pendingStart, inspectedCard].some(Boolean),
    kanban.exitBoard,
  );

  function inspect(card: BoardCard, completing: boolean) {
    setCompletingFanout(completing);
    setInspectedCard(card);
  }

  const moveActions: BoardMoveActions = {
    start: requestStart,
    move: (card, status) => kanban.moveCard(card, status),
    openCompletion: setCompletionCard,
    openFanoutCompletion: (card) => inspect(card, true),
  };

  // Route a card dropped into a different column to the matching transition. We
  // only honor the forward steps that have defined behavior; everything else
  // snaps back (the board is controlled by `kanban.cards`, untouched until a
  // transition persists and reloads).
  async function handleMove({ activeContainer, overContainer, event }: KanbanMoveEvent) {
    const card = boardCards.find((item) => item.id === String(event.active.id));
    if (!card) {
      return;
    }
    // A failed transition leaves the card where it was, since the board renders
    // from `kanban.cards`.
    const plan = planBoardMove(
      activeContainer as KanbanPromptStatus,
      overContainer as KanbanPromptStatus,
      card,
    );
    try {
      await runBoardMove(plan, card, moveActions);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }

  /** A fanout attempt was kept: reload, then finish completion if that's how we got here. */
  function handleFanoutPicked(card: BoardCard) {
    setInspectedCard(null);
    void workspace
      .refreshProject(card.projectId)
      .then(() => {
        if (completingFanout)
          setCompletionCard({ ...card, agentTabId: null, status: "reviewNeeded" });
        return undefined;
      })
      .catch((cause) => toast.error(errorMessage(cause)));
  }

  const cardActions: BoardCardActions = {
    onEditDraft: (card) => setDraftDialog({ open: true, card, seed: null }),
    onInspect: (card) => inspect(card, false),
    onDelete: setDeletionCard,
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      <BoardHeader projectName={workspace.activeProject?.name ?? null} onExit={kanban.exitBoard} />

      <div className="flex min-h-0 flex-1 overflow-x-auto p-4">
        <Kanban
          value={cardsByStatus as Record<string, KanbanPromptCard[]>}
          onValueChange={noop}
          getItemValue={(card) => card.id}
          onMove={(move) => void handleMove(move)}
          className="h-full min-h-0 w-full"
        >
          {/* Four equal columns that grow to fill a wide window, with an 18rem
              floor so a narrow one scrolls instead of crushing the cards. */}
          <KanbanBoard className="h-full grid-cols-[repeat(4,minmax(18rem,1fr))]">
            {COLUMNS.map((column) => (
              <BoardColumn
                key={column.status}
                column={column}
                cards={cardsByStatus[column.status]}
                suggestions={suggestions}
                onNewDraft={() => setDraftDialog({ open: true, card: null, seed: null })}
                onPickSuggestion={(suggestion) =>
                  setDraftDialog({ open: true, card: null, seed: seedFromSuggestion(suggestion) })
                }
                {...cardActions}
              />
            ))}
          </KanbanBoard>
          <BoardDragOverlay />
        </Kanban>
      </div>

      <KanbanDraftDialog
        open={draftDialog.open}
        card={draftDialog.card}
        seed={draftDialog.seed}
        onOpenChange={(open) =>
          setDraftDialog((current) => ({
            ...current,
            open,
            // A closing dialog drops its seed so reopening for a plain draft stays empty.
            seed: open ? current.seed : null,
          }))
        }
      />
      {inspectedCard ? (
        <KanbanWorktreeDialog
          card={boardCards.find((card) => card.id === inspectedCard.id) ?? inspectedCard}
          onClose={() => setInspectedCard(null)}
          onPicked={() => handleFanoutPicked(inspectedCard)}
        />
      ) : null}
      <KanbanCompletionDialog
        open={completionCard !== null}
        card={completionCard}
        onOpenChange={(open) => {
          if (!open) {
            setCompletionCard(null);
          }
        }}
      />
      <KanbanDeleteDialog
        open={deletionCard !== null}
        card={deletionCard}
        onOpenChange={(open) => {
          if (!open) {
            setDeletionCard(null);
          }
        }}
      />
      <MainBehindAlert
        behind={pendingStart?.main.behind ?? 0}
        mainWorktreeId={pendingStart?.main.id ?? null}
        onCancel={cancelPendingStart}
        onConfirm={confirmPendingStart}
      />
    </section>
  );
}

interface DraftSuggestionsProps {
  suggestions: BoardSuggestion[];
  /** Every available suggestion, including those behind "Load more". */
  total: number;
  notices: string[];
  loading: boolean;
  onPick: (suggestion: BoardSuggestion) => void;
  onDismiss: (key: string) => void;
  onLoadMore: () => void;
}

/**
 * The Drafts column's suggested-draft section: ghost cards from the built-in and
 * plugin providers, provider notices, and a "Load more" control once the page
 * limit is reached. Renders nothing when no provider has anything to say.
 */
function DraftSuggestions({
  suggestions,
  total,
  notices,
  loading,
  onPick,
  onDismiss,
  onLoadMore,
}: DraftSuggestionsProps) {
  if (suggestions.length === 0 && notices.length === 0 && !loading) {
    return null;
  }
  return (
    <div className="space-y-2 pt-1">
      <div className="px-0.5">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Suggested
        </span>
      </div>
      {loading && suggestions.length === 0 ? (
        <p className="px-1 py-2 text-center text-xs text-muted-foreground">
          Looking for suggestions…
        </p>
      ) : null}
      {suggestions.map((suggestion) => (
        <SuggestedDraftCard
          key={suggestion.key}
          suggestion={suggestion}
          onPick={() => onPick(suggestion)}
          onDismiss={() => onDismiss(suggestion.key)}
        />
      ))}
      {suggestions.length < total ? (
        <Button variant="ghost" size="sm" className="w-full text-xs" onClick={onLoadMore}>
          Load {total - suggestions.length} more
        </Button>
      ) : null}
      {notices.map((notice) => (
        <p
          key={notice}
          className="flex items-start gap-1.5 px-1 py-1 text-xs text-muted-foreground"
        >
          <Info className="mt-0.5 size-3 shrink-0" />
          {notice}
        </p>
      ))}
    </div>
  );
}
