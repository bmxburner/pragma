import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("loadOfficialPluginLock", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to the bundled lock when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { bundledOfficialPluginLock, loadOfficialPluginLock } = await import("./plugin-registry");

    await expect(loadOfficialPluginLock()).resolves.toEqual(bundledOfficialPluginLock());
  });

  // Onboarding renders its agent list from this promise. A request that never
  // settles (a proxy swallowing it, no DNS answer) must not hide every plugin.
  it("falls back to the bundled lock when the request never settles", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { bundledOfficialPluginLock, loadOfficialPluginLock } = await import("./plugin-registry");

    const pending = loadOfficialPluginLock();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual(bundledOfficialPluginLock());
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
