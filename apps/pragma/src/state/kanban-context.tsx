import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { projectIsGit } from "@/lib/non-git-project";
import { useRequiredContext } from "@/lib/context";

import { toast } from "sonner";

import type {
  Fanout,
  KanbanCompletedAction,
  KanbanPromptCard,
  Worktree,
} from "@pragma-sh/constants";

import { useAgentsList } from "@/hooks/use-agents-list";
import { startBackgroundAgentSession } from "@/lib/agent-launch";
import { commitThenDraftPullRequest } from "@/lib/commit-and-draft";
import { createPullRequest } from "@/lib/github";
import { defaultTabTitle } from "@/lib/tab-title";
import {
  type AgentConfig,
  aiCommitAllAndGeneratePullRequestDraft,
  aiGenerateCommitMessage,
  aiGeneratePullRequestDraft,
  commitStaged,
  createKanbanCard,
  createTab as createTabCommand,
  createWorktree,
  deleteKanbanCard,
  githubPushBranch,
  githubPullBranch,
  githubRepoRef,
  listKanbanCards,
  mergeWorktreeToParent,
  onKanbanChanged,
  stageAll,
  updateKanbanCard,
  worktreeStatus,
} from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";
import { useFanouts } from "@/state/fanouts-context";
import { useAgentStatusSnapshot } from "@/state/agent-status-store";
import {
  boardCardKey,
  projectBoardCards,
  type BoardAttempt,
  type BoardCard,
  type BoardPreferences,
} from "@/lib/kanban-model";
import {
  useBoardPreferences,
  useBoardPreferencesLoading,
  updateBoardPreferences,
} from "@/state/kanban-preferences";
import { trackWorktreeActivity } from "@/state/worktree-activity-store";

/** Which surface the workspace is showing: normal shell, agent board, or settings. */
type WorkspaceMode = "normal" | "kanban" | "settings";

/** Fields a draft card carries when created or edited. */
interface KanbanDraftInput {
  attempts?: BoardAttempt[];
  branchName: string;
  prompt: string;
  agentId: string;
  modelId: string | null;
  reasoningId: string | null;
}

interface KanbanContextValue {
  /** Whether the agent board or the normal workspace shell is visible. */
  mode: WorkspaceMode;
  /** Opens the board for the selected project (clears any return affordance). */
  openBoard: () => void;
  /** Opens the full-frame Settings workspace, optionally at a given section. */
  openSettings: (section?: string) => void;
  /** Leaves Settings for the surface that opened it. */
  closeSettings: () => void;
  /** Section Settings should open at, set by the last `openSettings` call. */
  settingsSection: string | null;
  /** Exits the board to the normal shell without leaving a return affordance. */
  exitBoard: () => void;
  /** Returns to the board (the "Back to agent board" control). */
  returnToKanban: () => void;
  /** True when a card-driven navigation left a "Back to agent board" affordance up. */
  backToKanbanAvailable: boolean;
  /** Cards for the selected project. */
  cards: BoardCard[];
  preferences: BoardPreferences;
  preferencesLoading: boolean;
  moveCard: (
    card: KanbanPromptCard,
    status: "inProgress" | "reviewNeeded" | "completed",
  ) => Promise<void>;
  loading: boolean;
  /** Configured agents, for resolving a card's agent name/config. */
  agents: AgentConfig[];
  /** Reloads the selected project's cards from SQLite. */
  reload: () => Promise<void>;
  createCard: (input: KanbanDraftInput) => Promise<void>;
  updateCardDraft: (card: KanbanPromptCard, input: KanbanDraftInput) => Promise<void>;
  /**
   * Removes a card. Drafts are card-only; every started card (in progress,
   * review, completed) also tears down its worktree with `force` — callers are
   * expected to confirm and warn about unmerged work first. `deleteBranch` also
   * removes the card's local branch (ignored for drafts, which own no worktree).
   */
  deleteCard: (card: KanbanPromptCard, options?: { deleteBranch?: boolean }) => Promise<void>;
  /** draft -> inProgress: create/reuse a worktree, launch the agent in a background tab. */
  startCard: (
    card: KanbanPromptCard,
    options?: { syncMainWorktreeId?: string | null },
  ) => Promise<void>;
  /** reviewNeeded -> completed via the chosen completion path. */
  runCompletion: (
    card: KanbanPromptCard,
    action: KanbanCompletedAction,
  ) => Promise<KanbanPromptCard>;
  /**
   * reviewNeeded -> completed as a background job: moves the card to Completed
   * immediately, then runs the commit/merge or commit/PR work without blocking.
   * The card id is held in {@link completing} (mapped to its action) for the
   * card's loading badge until the job finishes with a success/error toast. On
   * failure the card is moved back to Review needed.
   */
  completeCard: (card: KanbanPromptCard, action: KanbanCompletedAction) => Promise<void>;
  /** Cards running a background completion right now, keyed by id → its action. */
  completing: Record<string, KanbanCompletedAction>;
  /** Navigates the normal shell to a card's worktree/tab and shows Back to agent board. */
  openCardWorktree: (card: KanbanPromptCard) => void;
}

const KanbanContext = createContext<KanbanContextValue | null>(null);

function nowIso(): string {
  return new Date().toISOString();
}

/** Materializes metadata only when a discovered checkout needs a persisted board action. */
async function persistBoardCard(card: KanbanPromptCard): Promise<KanbanPromptCard> {
  const metadata: BoardCard = { ...card };
  delete metadata.fanout;
  delete metadata.attempts;
  if (!card.id.startsWith("worktree:")) return metadata;
  const created = await createKanbanCard(
    card.projectId,
    card.branchName,
    card.prompt,
    card.agentId,
    card.modelId ?? null,
    card.reasoningId ?? null,
  );
  return updateKanbanCard({ ...metadata, id: created.id });
}

/** Picks an existing worktree on the card's branch, or branches a fresh one off the project main. */
async function resolveStartCardWorktree(
  projectWorktrees: Worktree[],
  card: KanbanPromptCard,
  target: string,
): Promise<Worktree> {
  const existing = projectWorktrees.find((worktree) => worktree.branch === card.branchName);
  if (existing) {
    return existing;
  }
  const parent =
    projectWorktrees.find((item) => item.isMain) ??
    projectWorktrees.find((item) => item.parentId === null) ??
    projectWorktrees[0];
  if (!parent) {
    throw new Error("No parent worktree to branch from");
  }
  return createWorktree(target, parent.id, card.branchName);
}

/** Runs the git/AI/GitHub steps for a completion action, returning any PR reference it produced. */
async function applyCompletionAction(
  action: KanbanCompletedAction,
  worktreeId: string | undefined,
  card: KanbanPromptCard,
): Promise<{ pullRequestUrl: string | null; pullRequestNumber: number | null }> {
  if (action === "commitMerge" && worktreeId) {
    await trackWorktreeActivity(worktreeId, "commit", async () => {
      await stageAll(worktreeId);
      const message = await aiGenerateCommitMessage(worktreeId);
      await commitStaged(worktreeId, message);
    });
    await trackWorktreeActivity(worktreeId, "merge", () => mergeWorktreeToParent(worktreeId));
    return { pullRequestUrl: null, pullRequestNumber: null };
  }
  if (action === "commitPr" && worktreeId) {
    // A fanout winner is merged and committed into the parent by the host, so
    // completing that card has nothing left to commit: draft from the existing
    // commits instead of failing with "There are no changes to commit."
    const draft = await trackWorktreeActivity(worktreeId, "commit-and-draft", () =>
      commitThenDraftPullRequest({
        dirty: async () => (await worktreeStatus(worktreeId)).dirty,
        commitAndDraft: () => aiCommitAllAndGeneratePullRequestDraft(worktreeId),
        draftOnly: () => aiGeneratePullRequestDraft(worktreeId),
      }),
    );
    const repo = await githubRepoRef(worktreeId);
    await trackWorktreeActivity(worktreeId, "push", () => githubPushBranch(worktreeId));
    const pr = await trackWorktreeActivity(worktreeId, "create-pr", () =>
      createPullRequest(
        repo,
        { owner: repo.owner, repo: repo.repo, branch: repo.parentBranch ?? repo.defaultBranch },
        { title: draft.title, body: draft.body, draft: false, worktreeId },
      ),
    );
    return { pullRequestUrl: pr.htmlUrl, pullRequestNumber: pr.number };
  }
  return {
    pullRequestUrl: card.pullRequestUrl ?? null,
    pullRequestNumber: card.pullRequestNumber ?? null,
  };
}

/** Background completion: runs the action, persists the result, and restores the card on failure. */
async function runCompletionInBackground(
  card: KanbanPromptCard,
  action: KanbanCompletedAction,
  worktreeId: string,
  reload: () => Promise<void>,
): Promise<void> {
  try {
    const { pullRequestUrl, pullRequestNumber } = await applyCompletionAction(
      action,
      worktreeId,
      card,
    );
    await updateKanbanCard({
      ...card,
      status: "completed",
      completedAction: action,
      completedAt: card.completedAt ?? nowIso(),
      pullRequestUrl,
      pullRequestNumber,
    });
    toast.success(action === "commitMerge" ? "Merge complete" : "Pull request filed");
  } catch (cause) {
    // The job failed — return the card to Review needed so it can be retried.
    await updateKanbanCard({
      ...card,
      status: "reviewNeeded",
      completedAction: null,
      completedAt: null,
    });
    await updateBoardPreferences(card.projectId, (current) => ({
      ...current,
      overrides: { ...current.overrides, [boardCardKey(card)]: "reviewNeeded" },
    }));
    toast.error(cause instanceof Error ? cause.message : String(cause));
  } finally {
    await reload();
  }
}

/** Loads and clears cards as the selected project changes. */
function useKanbanCards(projectId: string | null): {
  cards: KanbanPromptCard[];
  loading: boolean;
  reload: () => Promise<void>;
  setCardStatus: (cardId: string, status: KanbanPromptCard["status"]) => void;
} {
  const [cards, setCards] = useState<KanbanPromptCard[]>([]);
  const [loading, setLoading] = useState(false);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const setCardStatus = useCallback((cardId: string, status: KanbanPromptCard["status"]) => {
    setCards((current) => current.map((card) => (card.id === cardId ? { ...card, status } : card)));
  }, []);
  const reload = useCallback(async () => {
    const target = projectIdRef.current;
    if (!target) {
      setCards([]);
      return;
    }
    setLoading(true);
    try {
      const loaded = await listKanbanCards(target);
      // Guard against a slow load landing after the user switched projects.
      if (projectIdRef.current === target) {
        setCards(loaded);
      }
    } finally {
      if (projectIdRef.current === target) {
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    if (!projectId) {
      setCards([]);
      return;
    }
    void reload();
  }, [projectId, reload]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onKanbanChanged((changedProjectId) => {
      if (changedProjectId === projectIdRef.current) void reload();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
      return undefined;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [projectIdRef, reload]);
  return { cards, loading, reload, setCardStatus };
}

/** Draft mutations: create, edit, and delete cards (and their worktrees). */
function useKanbanCardDrafts(
  workspaceRef: RefObject<ReturnType<typeof useWorkspace>>,
  projectIdRef: RefObject<string | null>,
  reload: () => Promise<void>,
): {
  createCard: (input: KanbanDraftInput) => Promise<void>;
  updateCardDraft: (card: KanbanPromptCard, input: KanbanDraftInput) => Promise<void>;
  deleteCard: (card: KanbanPromptCard, options?: { deleteBranch?: boolean }) => Promise<void>;
} {
  const createCard = useCallback(
    async (input: KanbanDraftInput) => {
      const target = projectIdRef.current;
      if (!target) {
        return;
      }
      const card = await createKanbanCard(
        target,
        input.branchName,
        input.prompt,
        input.agentId,
        input.modelId,
        input.reasoningId,
      );
      if (input.attempts?.length) {
        await updateBoardPreferences(target, (current) => ({
          ...current,
          attempts: { ...current.attempts, [card.id]: input.attempts! },
        }));
      }
      await reload();
    },
    [projectIdRef, reload],
  );
  const updateCardDraft = useCallback(
    async (card: KanbanPromptCard, input: KanbanDraftInput) => {
      const metadata = await persistBoardCard(card);
      await updateKanbanCard({
        ...metadata,
        branchName: input.branchName,
        prompt: input.prompt,
        agentId: input.agentId,
        modelId: input.modelId,
        reasoningId: input.reasoningId,
      });
      await updateBoardPreferences(card.projectId, (current) => ({
        ...current,
        attempts: { ...current.attempts, [card.id]: input.attempts ?? [] },
      }));
      await reload();
    },
    [reload],
  );
  const deleteCard = useCallback(
    async (card: KanbanPromptCard, options?: { deleteBranch?: boolean }) => {
      // A started card owns a worktree; remove it from disk first (force, since
      // the delete flow already confirms and warns about unmerged work), optionally
      // taking its local branch too. Drafts have no worktree and are simply dropped.
      if (card.status !== "draft" && card.worktreeId) {
        await workspaceRef.current.deleteWorktree(card.worktreeId, {
          deleteBranch: options?.deleteBranch ?? false,
          force: true,
        });
      }
      if (!card.id.startsWith("worktree:")) await deleteKanbanCard(card.id);
      await reload();
    },
    [workspaceRef, reload],
  );
  return { createCard, updateCardDraft, deleteCard };
}

/** Resources a `startCard` attempt created before it failed, so they can be rolled back. */
interface StartCardResources {
  createdWorktreeId: string | null;
  createdTabId: string | null;
}

/** Undoes whatever launch resources a failed `startCard` attempt created. */
async function rollbackStartCard(
  workspace: ReturnType<typeof useWorkspace>,
  resources: StartCardResources,
): Promise<void> {
  if (resources.createdTabId) {
    await workspace.closeTab(resources.createdTabId).catch(() => undefined);
  }
  if (resources.createdWorktreeId) {
    await workspace
      .deleteWorktree(resources.createdWorktreeId, { deleteBranch: true, force: true })
      .catch(() => undefined);
  }
}

/** Creates the worktree/tab/agent session for a card and persists it as started. */
async function launchCard(
  workspace: ReturnType<typeof useWorkspace>,
  card: KanbanPromptCard,
  agent: AgentConfig,
  resources: StartCardResources,
  syncMainWorktreeId: string | null,
): Promise<void> {
  const target = card.projectId;
  const projectWorktrees = workspace.worktrees[target] ?? [];
  if (!projectIsGit(workspace.projects.find((project) => project.id === target))) {
    throw new Error(
      "This project is not a git repository. Initialize one to run cards in their own worktree.",
    );
  }
  if (syncMainWorktreeId) {
    await githubPullBranch(syncMainWorktreeId);
  }
  // Reuse an existing worktree on the same branch; otherwise branch a fresh
  // one off the project's main worktree.
  const worktree = await resolveStartCardWorktree(projectWorktrees, card, target);
  if (!projectWorktrees.some((item) => item.id === worktree.id)) {
    resources.createdWorktreeId = worktree.id;
  }
  const tab = await createTabCommand(target, worktree.id, "terminal", defaultTabTitle("terminal"));
  resources.createdTabId = tab.id;
  // Load the new worktree + tab into workspace state so opening the card
  // later attaches to the (now persisted) background session.
  await workspace.refreshProject(target);
  await workspace.markTabAgent(tab.id, agent);
  await startBackgroundAgentSession(tab.id, worktree.id, worktree.path, agent, card.prompt, {
    modelId: card.modelId ?? null,
    reasoningId: card.reasoningId ?? null,
  });
  await updateKanbanCard({
    ...card,
    status: "inProgress",
    worktreeId: worktree.id,
    agentTabId: tab.id,
    startedAt: nowIso(),
  });
  await updateBoardPreferences(card.projectId, (current) => ({
    ...current,
    assignments: {
      ...current.assignments,
      [worktree.id]: current.assignments[card.id] ?? current.assignments[worktree.id] ?? "",
    },
  }));
}

/** Card lifecycle: start a card, run completion inline, complete in background, or open its worktree. */
function useKanbanCardLifecycle(
  workspaceRef: RefObject<ReturnType<typeof useWorkspace>>,
  agents: AgentConfig[],
  reload: () => Promise<void>,
  setCardStatus: (cardId: string, status: KanbanPromptCard["status"]) => void,
  setCompleting: (
    updater: (
      current: Record<string, KanbanCompletedAction>,
    ) => Record<string, KanbanCompletedAction>,
  ) => void,
  setBackToKanbanAvailable: (value: boolean) => void,
  setMode: (mode: WorkspaceMode) => void,
): {
  startCard: (
    card: KanbanPromptCard,
    options?: { syncMainWorktreeId?: string | null },
  ) => Promise<void>;
  runCompletion: (
    card: KanbanPromptCard,
    action: KanbanCompletedAction,
  ) => Promise<KanbanPromptCard>;
  completeCard: (card: KanbanPromptCard, action: KanbanCompletedAction) => Promise<void>;
  openCardWorktree: (card: KanbanPromptCard) => void;
} {
  const startCard = useCallback(
    async (card: KanbanPromptCard, options?: { syncMainWorktreeId?: string | null }) => {
      const agent = agents.find((item) => item.id === card.agentId) ?? agents[0];
      if (!agent) {
        throw new Error("No agent configured to start this card");
      }
      setCardStatus(card.id, "inProgress");
      let persisted = false;
      const resources: StartCardResources = { createdWorktreeId: null, createdTabId: null };
      try {
        await launchCard(
          workspaceRef.current,
          card,
          agent,
          resources,
          options?.syncMainWorktreeId ?? null,
        );
        persisted = true;
        await reload();
      } catch (cause) {
        if (!persisted) {
          setCardStatus(card.id, card.status);
          // Undo whatever launch resources this attempt created so a retry
          // doesn't pile up extra tabs/worktrees behind a card stuck in Draft.
          await rollbackStartCard(workspaceRef.current, resources);
        }
        throw cause;
      }
    },
    [agents, reload, setCardStatus, workspaceRef],
  );

  const runCompletion = useCallback(
    async (input: KanbanPromptCard, action: KanbanCompletedAction) => {
      const card = await persistBoardCard(input);
      const worktreeId = card.worktreeId;
      if (!worktreeId && action !== "manual") {
        throw new Error("Card has no worktree to complete");
      }
      const { pullRequestUrl, pullRequestNumber } = await applyCompletionAction(
        action,
        worktreeId ?? undefined,
        card,
      );
      const saved = await updateKanbanCard({
        ...card,
        status: "completed",
        completedAction: action,
        pullRequestUrl,
        pullRequestNumber,
        completedAt: nowIso(),
      });
      await reload();
      await updateBoardPreferences(card.projectId, (current) => ({
        ...current,
        overrides: { ...current.overrides, [boardCardKey(card)]: "completed" },
      }));
      return saved;
    },
    [reload],
  );

  const completeCard = useCallback(
    async (input: KanbanPromptCard, action: KanbanCompletedAction) => {
      const card = await persistBoardCard(input);
      const worktreeId = card.worktreeId;
      if (!worktreeId) {
        toast.error("Card has no worktree to complete");
        return;
      }
      // Optimistically move the card into Completed and flag it as running so the
      // card shows a "Merging…" / "Opening PR…" badge while the work happens.
      await updateKanbanCard({
        ...card,
        status: "completed",
        completedAction: action,
        completedAt: nowIso(),
      });
      setCompleting((current) => ({ ...current, [card.id]: action }));
      await reload();
      await updateBoardPreferences(card.projectId, (current) => ({
        ...current,
        overrides: { ...current.overrides, [boardCardKey(card)]: "completed" },
      }));
      // Run the heavy git/AI/GitHub work in the background, off the caller's await.
      void runCompletionInBackground(card, action, worktreeId, reload).finally(() => {
        setCompleting((current) => {
          const next = { ...current };
          delete next[card.id];
          return next;
        });
      });
    },
    [reload, setCompleting],
  );

  const openCardWorktree = useCallback(
    (card: KanbanPromptCard) => {
      const ws = workspaceRef.current;
      if (card.worktreeId) {
        ws.selectWorktree(card.worktreeId);
      }
      if (card.agentTabId) {
        ws.setActiveTab(card.agentTabId);
      }
      setBackToKanbanAvailable(true);
      setMode("normal");
    },
    [workspaceRef, setBackToKanbanAvailable, setMode],
  );

  return { startCard, runCompletion, completeCard, openCardWorktree };
}

/** Board surface mode (normal shell vs Kanban) and the return-to-board affordance. */
function useKanbanBoardMode(projectId: string | null): {
  mode: WorkspaceMode;
  backToKanbanAvailable: boolean;
  openBoard: () => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  settingsSection: string | null;
  exitBoard: () => void;
  returnToKanban: () => void;
  setBackToKanbanAvailable: (value: boolean) => void;
  setMode: (mode: WorkspaceMode) => void;
} {
  const [mode, setMode] = useState<WorkspaceMode>("normal");
  const [backToKanbanAvailable, setBackToKanbanAvailable] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const settingsReturnMode = useRef<Exclude<WorkspaceMode, "settings">>("normal");
  const openBoard = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("kanban");
  }, []);
  const openSettings = useCallback((section?: string) => {
    setBackToKanbanAvailable(false);
    setSettingsSection(section ?? null);
    setMode((current) => {
      if (current !== "settings") settingsReturnMode.current = current;
      return "settings";
    });
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsSection(null);
    setMode(settingsReturnMode.current);
  }, []);
  const exitBoard = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("normal");
  }, []);
  const returnToKanban = useCallback(() => {
    setBackToKanbanAvailable(false);
    setMode("kanban");
  }, []);
  // A project switch invalidates a card-driven return affordance (it pointed at
  // the previous project's worktree).
  useEffect(() => {
    setBackToKanbanAvailable(false);
  }, [projectId]);
  return {
    mode,
    backToKanbanAvailable,
    openBoard,
    openSettings,
    closeSettings,
    settingsSection,
    exitBoard,
    returnToKanban,
    setBackToKanbanAvailable,
    setMode,
  };
}

/** The board projected from saved cards and the project's live checkouts. */
function useProjectBoardCards(
  projectId: string | null,
  savedCards: KanbanPromptCard[],
  statuses: ReturnType<typeof useAgentStatusSnapshot>,
  fanouts: Fanout[],
  preferences: BoardPreferences,
): BoardCard[] {
  const workspace = useWorkspace();
  return useMemo(
    () =>
      projectBoardCards(
        savedCards,
        projectId ? (workspace.worktrees[projectId] ?? []) : [],
        workspace.tabs,
        statuses,
        fanouts,
        preferences.overrides,
      ),
    [
      savedCards,
      workspace.worktrees,
      workspace.tabs,
      projectId,
      statuses,
      fanouts,
      preferences.overrides,
    ],
  );
}

/** Running cards that were completed (manually or by record) and were not held by fix-it. */
function reopenedCards(cards: BoardCard[], overrides: BoardPreferences["overrides"]): string[] {
  return cards.flatMap((card) => {
    if (card.status !== "inProgress" || !card.worktreeId) return [];
    const override = overrides[card.worktreeId];
    const wasCompleted = override === "completed" || (override === undefined && card.completedAt);
    return wasCompleted ? [card.worktreeId] : [];
  });
}

/** A fresh ordinary run reopens a completed card. Fix-it's explicit hold wins. */
function useReopenCompletedCards(
  projectId: string | null,
  cards: BoardCard[],
  overrides: BoardPreferences["overrides"],
) {
  useEffect(() => {
    if (!projectId) return;
    const reopened = reopenedCards(cards, overrides);
    if (!reopened.length) return;
    void updateBoardPreferences(projectId, (current) => ({
      ...current,
      overrides: {
        ...current.overrides,
        ...Object.fromEntries(reopened.map((worktreeId) => [worktreeId, "reviewNeeded" as const])),
      },
    })).catch((cause) => toast.error(cause instanceof Error ? cause.message : String(cause)));
  }, [cards, overrides, projectId]);
}

/** The project's saved cards, board preferences, and the live board projected from them. */
function useBoardData(projectId: string | null) {
  const fanouts = useFanouts();
  const statuses = useAgentStatusSnapshot();
  const { cards: savedCards, loading, reload, setCardStatus } = useKanbanCards(projectId);
  const preferences = useBoardPreferences(projectId);
  const preferencesLoading = useBoardPreferencesLoading(projectId);
  const cards = useProjectBoardCards(projectId, savedCards, statuses, fanouts.fanouts, preferences);
  useReopenCompletedCards(projectId, cards, preferences.overrides);
  return { fanouts, cards, loading, reload, setCardStatus, preferences, preferencesLoading };
}

/** Moves a card between workflow columns and records the choice as an override. */
function useBoardMoveCard(reload: () => Promise<void>): KanbanContextValue["moveCard"] {
  return useCallback(
    async (card: KanbanPromptCard, status: "inProgress" | "reviewNeeded" | "completed") => {
      const saved = await persistBoardCard(card);
      await updateKanbanCard({
        ...saved,
        status,
        completedAt: status === "completed" ? nowIso() : null,
      });
      await updateBoardPreferences(card.projectId, (current) => ({
        ...current,
        overrides: { ...current.overrides, [boardCardKey(card)]: status },
      }));
      await reload();
    },
    [reload],
  );
}

/**
 * Starts a card: a single-agent launch, or — when the draft saved attempts — a
 * host fanout branched from the project's main checkout.
 */
function useBoardStartCard(
  workspaceRef: RefObject<ReturnType<typeof useWorkspace>>,
  preferences: BoardPreferences,
  startSingleCard: KanbanContextValue["startCard"],
  fanouts: ReturnType<typeof useFanouts>,
  reload: () => Promise<void>,
): KanbanContextValue["startCard"] {
  return useCallback(
    async (card: KanbanPromptCard, options?: { syncMainWorktreeId?: string | null }) => {
      const metadata = await persistBoardCard(card);
      const attempts = preferences.attempts[card.id];
      if (!attempts?.length) return startSingleCard(metadata, options);
      const parent = workspaceRef.current.worktrees[card.projectId]?.find(
        (worktree) => worktree.isMain,
      );
      if (!parent) throw new Error("No parent worktree to branch from");
      if (options?.syncMainWorktreeId) await githubPullBranch(options.syncMainWorktreeId);
      const result = await fanouts.create({
        projectId: card.projectId,
        parent: { kind: "new", sourceWorktreeId: parent.id, branch: card.branchName, title: null },
        prompt: card.prompt,
        defaultReasoningId: null,
        members: attempts.map(({ selector, modelId, reasoningId }) => ({
          selector,
          modelId,
          reasoningId,
        })),
      });
      await updateKanbanCard({
        ...metadata,
        worktreeId: result.fanout.parentWorktreeId,
        status: "inProgress",
        startedAt: nowIso(),
      });
      await updateBoardPreferences(card.projectId, (current) => ({
        ...current,
        assignments: {
          ...current.assignments,
          [result.fanout.parentWorktreeId]: current.assignments[card.id] ?? "",
        },
      }));
      await workspaceRef.current.refreshProject(card.projectId);
      await reload();
    },
    [workspaceRef, preferences.attempts, startSingleCard, fanouts, reload],
  );
}

export function KanbanProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const [completing, setCompleting] = useState<Record<string, KanbanCompletedAction>>({});

  const projectId = workspace.selectedProjectId;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Latest workspace handles, readable from stable callbacks without re-creating
  // them on every workspace state change.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const {
    mode,
    backToKanbanAvailable,
    openBoard,
    openSettings,
    closeSettings,
    settingsSection,
    exitBoard,
    returnToKanban,
    setBackToKanbanAvailable,
    setMode,
  } = useKanbanBoardMode(projectId);
  const agents = useAgentsList();
  const { fanouts, cards, loading, reload, setCardStatus, preferences, preferencesLoading } =
    useBoardData(projectId);
  const moveCard = useBoardMoveCard(reload);
  const { createCard, updateCardDraft, deleteCard } = useKanbanCardDrafts(
    workspaceRef,
    projectIdRef,
    reload,
  );
  const {
    startCard: startSingleCard,
    runCompletion,
    completeCard,
    openCardWorktree,
  } = useKanbanCardLifecycle(
    workspaceRef,
    agents,
    reload,
    setCardStatus,
    setCompleting,
    setBackToKanbanAvailable,
    setMode,
  );
  const startCard = useBoardStartCard(workspaceRef, preferences, startSingleCard, fanouts, reload);

  const value = useMemo<KanbanContextValue>(
    () => ({
      mode: projectId || mode === "settings" ? mode : "normal",
      openBoard,
      openSettings,
      closeSettings,
      settingsSection,
      exitBoard,
      returnToKanban,
      backToKanbanAvailable,
      cards,
      preferences,
      preferencesLoading,
      moveCard,
      loading,
      agents,
      reload,
      createCard,
      updateCardDraft,
      deleteCard,
      startCard,
      runCompletion,
      completeCard,
      completing,
      openCardWorktree,
    }),
    [
      projectId,
      mode,
      openBoard,
      openSettings,
      closeSettings,
      settingsSection,
      exitBoard,
      returnToKanban,
      backToKanbanAvailable,
      cards,
      preferences,
      preferencesLoading,
      moveCard,
      loading,
      agents,
      reload,
      createCard,
      updateCardDraft,
      deleteCard,
      startCard,
      runCompletion,
      completeCard,
      completing,
      openCardWorktree,
    ],
  );

  return <KanbanContext.Provider value={value}>{children}</KanbanContext.Provider>;
}

/** Accesses the project agent-board state and actions. */
export function useKanban(): KanbanContextValue {
  return useRequiredContext(KanbanContext, "useKanban");
}
