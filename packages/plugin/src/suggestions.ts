import type { PluginIcon, PluginWhen } from "./contributions";
import type { ContextWorktree } from "./context";
import type { PluginContext, PluginProject } from "./types";

/** Suggested drafts a board surfaces before its "Load more" control. */
export const SUGGESTED_DRAFT_PAGE_SIZE = 20;

/**
 * One draft a provider proposes for the agent board's Drafts column. It is
 * shown as a ghost card; a user who picks it gets a pre-filled draft dialog
 * and nothing is persisted until they save.
 */
export interface SuggestedDraft<TData = unknown> {
  /** Stable id, unique within its provider. */
  id: string;
  /** Branch name the prefilled draft should use. */
  branchName: string;
  /** The prompt the draft carries into its dialog. */
  prompt: string;
  /** Short card label; falls back to the branch name when omitted. */
  title?: string;
  /** Secondary line for the card (e.g. the source issue's title). */
  description?: string;
  /** Per-draft icon component; falls back to the provider's icon. */
  icon?: PluginIcon;
  /** Per-draft image (PNG/SVG URL, absolute path, or plugin-dir-relative path). */
  iconPath?: string;
  /** Preferred agent id; the dialog falls back to the project default when absent. */
  agentId?: string;
  /** Opaque data handed back to the host. Must be JSON-serializable. */
  data?: TData;
}

/** Input to {@link SuggestedDraftProviderDefinition.suggest}. */
export interface SuggestedDraftInput {
  /** The active project, or `null` when none is selected. */
  project: PluginProject | null;
  /** A representative worktree for the project (its main checkout), or `null`. */
  worktree: ContextWorktree | null;
  /** Most items to return; the board may show fewer. */
  limit: number;
  /** Aborted when the board closes or the project changes. */
  signal: AbortSignal;
}

/**
 * A source of suggested drafts for the agent board: open issues, failing
 * checks, unread notifications… `suggest` lists candidates for the active
 * project; the host renders each as a pickable ghost card in Drafts.
 */
export interface SuggestedDraftProviderDefinition<TConfig = unknown, TData = unknown> {
  /** Stable id, unique within the plugin. */
  id: string;
  /** Group heading shown above the provider's suggested cards. */
  title: string;
  /** Icon component for the provider and its drafts. */
  icon?: PluginIcon;
  /** Image for the provider and its drafts (PNG/SVG URL, absolute path, or plugin-relative path). */
  iconPath?: string;
  /** Hides the provider when it returns false. */
  when?: PluginWhen<TConfig>;
  /** Lists suggested drafts for the active project. */
  suggest(
    input: SuggestedDraftInput,
    ctx: PluginContext<TConfig>,
  ): SuggestedDraft<TData>[] | Promise<SuggestedDraft<TData>[]>;
}

/**
 * Thrown from a provider's `suggest` to show `message` on the board instead of
 * cards — e.g. "Sign in to Linear to see suggestions." Any other error is logged
 * and the provider shows nothing.
 */
export class SuggestedDraftProviderNotice extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestedDraftProviderNotice";
  }
}

/**
 * Whether `cause` is a {@link SuggestedDraftProviderNotice}. Checks the name,
 * not the class, because each plugin bundle carries its own copy of this module.
 */
export function isSuggestedDraftProviderNotice(
  cause: unknown,
): cause is SuggestedDraftProviderNotice {
  return cause instanceof Error && cause.name === "SuggestedDraftProviderNotice";
}

/** Declares a suggested-draft provider contribution. */
export function defineSuggestedDraftProvider<TConfig = unknown, TData = unknown>(
  input: SuggestedDraftProviderDefinition<TConfig, TData>,
): SuggestedDraftProviderDefinition<TConfig, TData> {
  return input;
}
