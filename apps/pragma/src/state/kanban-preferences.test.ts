import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";

const data = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/tauri", () => ({
  readKanbanPreferences: vi.fn(async (projectId: string) => data.get(projectId) ?? null),
  writeKanbanPreferences: vi.fn(async (projectId: string, value: string) => {
    data.set(projectId, value);
  }),
}));
beforeEach(() => {
  data.clear();
  vi.resetModules();
});
afterEach(cleanup);

describe("board preferences", () => {
  it("isolates project categories and persists a manual fix-it hold across reloads", async () => {
    const store = await import("./kanban-preferences");
    const first = renderHook(() => store.useBoardPreferences("first"));
    const second = renderHook(() => store.useBoardPreferences("second"));
    await act(async () => {
      await store.updateBoardPreferences("first", (current) => ({
        ...current,
        categories: [{ id: "category", name: "Bug", color: "#123456" }],
        assignments: { worktree: "category" },
      }));
      await store.markBoardFixInProgress("first", "worktree");
    });
    expect(first.result.current.categories[0]?.name).toBe("Bug");
    expect(second.result.current.categories).toEqual([]);
    cleanup();
    vi.resetModules();
    const restored = await import("./kanban-preferences");
    const result = renderHook(() => restored.useBoardPreferences("first"));
    await waitFor(() => expect(result.result.current.overrides.worktree).toBe("inProgress"));
    expect(result.result.current.assignments.worktree).toBe("category");
  });
  it("ignores malformed stored project data", async () => {
    data.set("broken", '{"categories":null}');
    const store = await import("./kanban-preferences");
    expect(renderHook(() => store.useBoardPreferences("broken")).result.current.categories).toEqual(
      [],
    );
  });
  it("serializes simultaneous changes without losing category assignments or workflow state", async () => {
    const store = await import("./kanban-preferences");
    await Promise.all([
      store.updateBoardPreferences("p", (current) => ({
        ...current,
        assignments: { worktree: "category" },
      })),
      store.markBoardFixInProgress("p", "worktree"),
    ]);
    const saved = JSON.parse(data.get("p")!);
    expect(saved.assignments.worktree).toBe("category");
    expect(saved.overrides.worktree).toBe("inProgress");
  });

  it("backfills dismissed suggestions on legacy documents and persists new ones", async () => {
    data.set(
      "legacy",
      JSON.stringify({
        categories: [],
        assignments: { worktree: "category" },
        attempts: {},
        overrides: { worktree: "completed" },
      }),
    );
    const store = await import("./kanban-preferences");
    const result = renderHook(() => store.useBoardPreferences("legacy"));
    await waitFor(() => expect(result.result.current.overrides.worktree).toBe("completed"));
    expect(result.result.current.dismissedSuggestions).toEqual([]);

    await act(async () => {
      await store.updateBoardPreferences("legacy", (current) => ({
        ...current,
        dismissedSuggestions: ["builtin:github-issues:issue-12"],
      }));
    });
    expect(result.result.current.dismissedSuggestions).toEqual(["builtin:github-issues:issue-12"]);
    expect(JSON.parse(data.get("legacy")!).dismissedSuggestions).toEqual([
      "builtin:github-issues:issue-12",
    ]);
  });
});
