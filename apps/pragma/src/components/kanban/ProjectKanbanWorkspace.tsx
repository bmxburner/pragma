import { useEffect, useMemo, useState } from "react";

import { GripVertical, Info, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { SUGGESTED_DRAFT_PAGE_SIZE } from "@pragma-sh/plugin/catalog";
import type { KanbanPromptCard, KanbanPromptStatus } from "@pragma-sh/constants";

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
import { planBoardMove } from "@/lib/kanban-board-move";
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
  const { authenticated } = useGitHub();
  const projectWorktrees = useMemo(
    () =>
      workspace.selectedProjectId ? (workspace.worktrees[workspace.selectedProjectId] ?? []) : [],
    [workspace.selectedProjectId, workspace.worktrees],
  );
  const { prNumberByWorktreeId } = useWorktreePrLifecycles(projectWorktrees, authenticated);
  const [inspectedCard, setInspectedCard] = useState<BoardCard | null>(null);
  const [completingFanout, setCompletingFanout] = useState(false);
  const boardCards = useMemo(
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
  const [draftDialog, setDraftDialog] = useState<{
    open: boolean;
    card: KanbanPromptCard | null;
    seed: KanbanDraftSeed | null;
  }>({ open: false, card: null, seed: null });
  const [completionCard, setCompletionCard] = useState<KanbanPromptCard | null>(null);
  const [deletionCard, setDeletionCard] = useState<KanbanPromptCard | null>(null);
  const [pendingStart, setPendingStart] = useState<{
    card: KanbanPromptCard;
    main: MainBehindRemote;
  } | null>(null);

  // Plugin-suggested drafts are proposed against the project's main checkout (the
  // GitHub provider reads its repo ref from there). They render as ghost cards in
  // Drafts; picking one pre-fills the draft dialog and nothing is persisted until save.
  const mainWorktree = projectWorktrees.find((worktree) => worktree.isMain) ?? null;
  const suggestionProviders = useSuggestedDraftProviders(workspace.selectedProjectId);
  const {
    suggestions,
    notices: suggestionNotices,
    loading: suggestionsLoading,
  } = useSuggestedDrafts({
    isOpen: true,
    providers: suggestionProviders,
    project: workspace.activeProject,
    worktree: mainWorktree,
  });
  const [suggestionLimit, setSuggestionLimit] = useState(SUGGESTED_DRAFT_PAGE_SIZE);
  useEffect(() => setSuggestionLimit(SUGGESTED_DRAFT_PAGE_SIZE), [workspace.selectedProjectId]);
  const availableSuggestions = useMemo(() => {
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
  const visibleSuggestions = availableSuggestions.slice(0, suggestionLimit);

  const cardsByStatus = useMemo(() => {
    const groups: Record<KanbanPromptStatus, BoardCard[]> = {
      draft: [],
      inProgress: [],
      reviewNeeded: [],
      completed: [],
    };
    for (const card of boardCards) {
      // While the completion modal is open for a dragged card, show it parked in
      // Completed (it's not persisted there until a completion path runs, so a
      // cancel just drops this override and the card snaps back).
      const status = card.id === completionCard?.id ? "completed" : card.status;
      groups[status].push(card);
    }
    return groups;
  }, [boardCards, completionCard]);

  const anyDialogOpen =
    draftDialog.open ||
    completionCard !== null ||
    deletionCard !== null ||
    pendingStart !== null ||
    inspectedCard !== null;

  // Escape exits the board when no modal is open (modals own their own Escape).
  const { exitBoard } = kanban;
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

  function agentConfig(card: KanbanPromptCard): AgentConfig | null {
    return kanban.agents.find((agent) => agent.id === card.agentId) ?? null;
  }

  async function start(card: KanbanPromptCard, syncMainWorktreeId: string | null = null) {
    try {
      await kanban.startCard(card, { syncMainWorktreeId });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function requestStart(card: KanbanPromptCard) {
    try {
      const targetWorktrees = workspace.worktrees[card.projectId] ?? [];
      const behindMain = await mainBehindRemote(targetWorktrees);
      if (behindMain) {
        setPendingStart({ card, main: behindMain });
        return;
      }
      await start(card);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // Route a card dropped into a different column to the matching transition. We
  // only honor the forward steps that have defined behavior; everything else
  // snaps back (the board is controlled by `kanban.cards`, untouched until a
  // transition persists and reloads).
  async function handleMove({ activeContainer, overContainer, event }: KanbanMoveEvent) {
    const from = activeContainer as KanbanPromptStatus;
    const to = overContainer as KanbanPromptStatus;
    const card = boardCards.find((item) => item.id === String(event.active.id));
    if (!card) {
      return;
    }

    // The plan is pure; only the side effects live here. A failed transition
    // leaves the card where it was, since the board renders from `kanban.cards`.
    const plan = planBoardMove(from, to, card);
    try {
      switch (plan.kind) {
        case "start":
          await requestStart(card);
          break;
        case "move":
          await kanban.moveCard(card, plan.status);
          break;
        case "completionDialog":
          setCompletionCard(card);
          break;
        case "fanoutCompletion":
          setCompletingFanout(true);
          setInspectedCard(card);
          break;
        case "blocked":
          toast.info("That move isn't available — use the card's actions to advance it.");
          break;
        case "noop":
          break;
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** Opens the draft dialog seeded from a suggestion; nothing is saved until submit. */
  function pickSuggestion(suggestion: BoardSuggestion) {
    setDraftDialog({
      open: true,
      card: null,
      seed: {
        branchName: suggestion.draft.branchName,
        prompt: suggestion.draft.prompt,
        agentId: suggestion.draft.agentId ?? null,
      },
    });
  }

  /** Hides a suggestion for this project by recording its key in board preferences. */
  function dismissSuggestion(key: string) {
    const projectId = workspace.selectedProjectId;
    if (!projectId) return;
    void updateBoardPreferences(projectId, (current) => ({
      ...current,
      dismissedSuggestions: current.dismissedSuggestions.includes(key)
        ? current.dismissedSuggestions
        : [...current.dismissedSuggestions, key],
    })).catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)));
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* The board takes the full frame (the sidebar is hidden), so its header is
          the window's top-left chrome: it pads past the macOS traffic lights and
          doubles as a titlebar drag region. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- native titlebar drag region */}
      <header
        className="flex items-center justify-between gap-3 border-b border-sidebar-border bg-sidebar px-4 pt-[calc(var(--titlebar-height,0px)+0.75rem)] pb-3"
        onMouseDown={startWindowDrag}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-base font-semibold">Agent board</h1>
          {workspace.activeProject ? (
            <span className="truncate text-sm text-muted-foreground">
              {workspace.activeProject.name}
            </span>
          ) : null}
        </div>
        <Button size="sm" variant="outline" onClick={exitBoard}>
          Exit agent board
          <X className="size-3.5" />
        </Button>
      </header>

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
            {COLUMNS.map((column) => {
              const cards = cardsByStatus[column.status];
              const hasSuggestionSection =
                column.status === "draft" &&
                (visibleSuggestions.length > 0 ||
                  suggestionNotices.length > 0 ||
                  suggestionsLoading);
              return (
                // Columns stay put (we render no column drag handle, so they can't
                // be dragged) but remain drop targets so cards land in empty columns.
                <KanbanColumn key={column.status} value={column.status} className="min-w-0">
                  {/* Fixed-height action row keeps every column header aligned while
                      the New draft button sits directly above the Drafts column. */}
                  <div className="mb-2 flex h-8 items-center">
                    {column.status === "draft" ? (
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!workspace.selectedProjectId || kanban.preferencesLoading}
                        onClick={() => setDraftDialog({ open: true, card: null, seed: null })}
                      >
                        <Plus className="size-4" />
                        New draft
                      </Button>
                    ) : null}
                  </div>

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
                        <KanbanItem
                          key={card.id}
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
                            onOpen={() =>
                              card.status === "draft"
                                ? setDraftDialog({ open: true, card, seed: null })
                                : kanban.openCardWorktree(card)
                            }
                            onDelete={() => setDeletionCard(card)}
                          >
                            <div className="min-w-0 flex-1">
                              <KanbanCard
                                card={card}
                                agent={agentConfig(card)}
                                completingAction={kanban.completing[card.id] ?? null}
                                onEdit={(item) =>
                                  setDraftDialog({ open: true, card: item, seed: null })
                                }
                                onOpen={(item) => {
                                  // Fanouts, running work, review work, and PRs all
                                  // open the preview dialog; other idle cards jump
                                  // straight to their worktree.
                                  const opensPreview =
                                    Boolean(card.fanout) ||
                                    card.status === "inProgress" ||
                                    card.status === "reviewNeeded" ||
                                    Boolean(card.pullRequestNumber);
                                  if (item.worktreeId !== card.worktreeId || !opensPreview) {
                                    kanban.openCardWorktree(item);
                                    return;
                                  }
                                  setCompletingFanout(false);
                                  setInspectedCard(card);
                                }}
                                category={kanban.preferences.categories.find(
                                  (category) =>
                                    category.id ===
                                    kanban.preferences.assignments[boardCardKey(card)],
                                )}
                                onDelete={(item) => setDeletionCard(item)}
                              />
                            </div>
                          </KanbanCategoryMenu>
                        </KanbanItem>
                      ))}
                      {column.status === "draft" ? (
                        <DraftSuggestions
                          suggestions={visibleSuggestions}
                          total={availableSuggestions.length}
                          notices={suggestionNotices}
                          loading={suggestionsLoading}
                          onPick={pickSuggestion}
                          onDismiss={dismissSuggestion}
                          onLoadMore={() =>
                            setSuggestionLimit((current) => current + SUGGESTED_DRAFT_PAGE_SIZE)
                          }
                        />
                      ) : null}
                      {cards.length === 0 && !hasSuggestionSection ? (
                        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                          {column.status === "draft" && !kanban.loading
                            ? "Add a draft to get started."
                            : "Nothing here yet."}
                        </p>
                      ) : null}
                    </KanbanColumnContent>
                  </div>
                </KanbanColumn>
              );
            })}
          </KanbanBoard>

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
                    agent={agentConfig(card)}
                    completingAction={kanban.completing[card.id] ?? null}
                    onEdit={() => {}}
                    onOpen={() => {}}
                    onDelete={() => {}}
                  />
                </div>
              );
            }}
          </KanbanOverlay>
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
          onPicked={() => {
            const card = inspectedCard;
            setInspectedCard(null);
            void workspace
              .refreshProject(card.projectId)
              .then(() => {
                if (completingFanout)
                  setCompletionCard({ ...card, agentTabId: null, status: "reviewNeeded" });
                return undefined;
              })
              .catch((cause) =>
                toast.error(cause instanceof Error ? cause.message : String(cause)),
              );
          }}
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
        onCancel={() => setPendingStart(null)}
        onConfirm={(pullFirst) => {
          const pending = pendingStart;
          setPendingStart(null);
          if (pending) {
            void start(pending.card, pullFirst ? pending.main.id : null);
          }
        }}
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
