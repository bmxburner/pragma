import { type MouseEvent, useCallback } from "react";

import { GitBranch, X } from "lucide-react";

import { IconTooltip } from "@/components/ui/icon-button";
import type { BoardSuggestion } from "@/hooks/use-suggested-drafts";
import { cn } from "@/lib/utils";

interface SuggestedDraftCardProps {
  suggestion: BoardSuggestion;
  /** Opens the draft dialog pre-filled from this suggestion. */
  onPick: () => void;
  /** Hides this suggestion for the project. */
  onDismiss: () => void;
}

/** The draft's own icon or image, else its provider's, or nothing when neither declares one. */
function SuggestionIcon({ suggestion }: { suggestion: BoardSuggestion }) {
  const { provider, draft } = suggestion;
  const className = "size-3.5 shrink-0 text-muted-foreground";
  const draftUrl = provider.draftIconUrl(draft);
  if (draft.icon) return <draft.icon className={className} />;
  if (draftUrl) return <img src={draftUrl} alt="" className="size-3.5 shrink-0 object-contain" />;
  if (provider.icon) return <provider.icon className={className} />;
  if (provider.iconUrl) {
    return <img src={provider.iconUrl} alt="" className="size-3.5 shrink-0 object-contain" />;
  }
  return null;
}

/**
 * A ghost card in the Drafts column: a plugin-suggested draft the user can pick
 * (opening the draft dialog pre-filled, nothing persisted until save) or dismiss.
 * It is deliberately not a `KanbanItem` — suggestions are not draggable and never
 * participate in board moves.
 */
export function SuggestedDraftCard({ suggestion, onPick, onDismiss }: SuggestedDraftCardProps) {
  const { provider, draft } = suggestion;
  const title = draft.title ?? draft.branchName;
  const handleDismiss = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onDismiss();
    },
    [onDismiss],
  );

  return (
    <div className="group/suggestion relative rounded-lg border border-dashed border-border bg-card/40 shadow-sm transition-colors hover:border-foreground/30 hover:bg-card/70">
      <button type="button" onClick={onPick} className="block w-full space-y-2 p-3 text-left">
        <div className="flex items-center gap-1.5 pr-6 text-xs text-muted-foreground">
          <SuggestionIcon suggestion={suggestion} />
          <span className="truncate font-medium">{provider.title}</span>
        </div>

        <p className="line-clamp-2 text-sm font-medium">{title}</p>
        {draft.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{draft.description}</p>
        ) : null}

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{draft.branchName}</span>
        </div>
      </button>
      <IconTooltip label="Dismiss suggestion">
        <button
          type="button"
          aria-label="Dismiss suggestion"
          onClick={handleDismiss}
          className={cn(
            "absolute top-2 right-2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity",
            "group-hover/suggestion:opacity-100 focus-visible:opacity-100 hover:text-destructive",
          )}
        >
          <X className="size-3.5" />
        </button>
      </IconTooltip>
    </div>
  );
}
