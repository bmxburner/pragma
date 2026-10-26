import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { KanbanPromptCard } from "@pragma-sh/constants";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IconButton } from "@/components/ui/icon-button";
import { boardCardKey, type BoardPreferences } from "@/lib/kanban-model";
import { useKanban } from "@/state/kanban-context";
import { updateBoardPreferences } from "@/state/kanban-preferences";

/** Project category picker and editor, shared by worktree and draft cards. */
export function KanbanCategoryMenu({
  card,
  children,
  onOpen,
  onDelete,
}: {
  card: KanbanPromptCard;
  children: ReactNode;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { preferences } = useKanban();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#7799cc");
  const [busy, setBusy] = useState(false);
  const key = boardCardKey(card);
  async function update(change: (current: BoardPreferences) => BoardPreferences): Promise<boolean> {
    try {
      await updateBoardPreferences(card.projectId, change);
      return true;
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen}>
            {card.status === "draft" ? "Edit draft" : "Open worktree"}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Set category</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() =>
                  update((current) => ({
                    ...current,
                    assignments: { ...current.assignments, [key]: "" },
                  }))
                }
              >
                No category
              </ContextMenuItem>
              {preferences.categories.map((category) => (
                <div key={category.id} className="flex items-center">
                  <ContextMenuItem
                    className="flex-1"
                    onSelect={() =>
                      update((current) => ({
                        ...current,
                        assignments: { ...current.assignments, [key]: category.id },
                      }))
                    }
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: category.color }}
                    />
                    {category.name}
                  </ContextMenuItem>
                  <IconButton
                    label={`Delete category ${category.name}`}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      update((current) => ({
                        ...current,
                        categories: current.categories.filter((item) => item.id !== category.id),
                        assignments: Object.fromEntries(
                          Object.entries(current.assignments).filter(
                            ([, id]) => id !== category.id,
                          ),
                        ),
                      }))
                    }
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setAdding(true)}>Add category…</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add category</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!name.trim() || busy) return;
              setBusy(true);
              const id = crypto.randomUUID();
              const saved = await update((current) => ({
                ...current,
                categories: [...current.categories, { id, name: name.trim(), color }],
                assignments: { ...current.assignments, [key]: id },
              }));
              if (saved) {
                setAdding(false);
                setName("");
              }
              setBusy(false);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="board-category-name">Category name</Label>
              <Input
                id="board-category-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="board-category-color">Color</Label>
              <Input
                id="board-category-color"
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!name.trim() || busy}>
                Add category
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
