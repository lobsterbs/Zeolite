import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUpdateReload } from "../bootstrap/update";
import { broadcastEngineUpdate, engineSha, startUpdateChecks } from "../updates";
import { ZEOLITE_VERSION } from "../swstate";

/* #121: stale-engine alerting. The bootstrap listener reloads a page
   once per engine sha; the worker module hashes its own script,
   broadcasts zl:engineUpdate to window clients and polls
   registration.update(). */

describe("applyUpdateReload (#121 bootstrap)", () => {
  const mk = (storage?: Storage) => {
    const store = new Map<string, string>();
    const reload = vi.fn();
    let handler: ((ev: MessageEvent) => void) | undefined;
    const sessionStorage: Storage =
      storage ??
      ({
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      } as unknown as Storage);
    const w = {
      navigator: {
        serviceWorker: {
          addEventListener: (t: string, f: (ev: MessageEvent) => void) => {
            if (t === "message") handler = f;
          },
        },
      },
      sessionStorage,
      location: { reload },
    };
    applyUpdateReload(w as unknown as Record<string, unknown>);
    return {
      fire: (d: unknown) => handler!({ data: d } as MessageEvent),
      reload,
      store,
    };
  };

  it("reloads once per engine sha and skips replays of the same sha", () => {
    const { fire, reload, store } = mk();
    fire({ type: "zl:engineUpdate", sha: "aaaa" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.get("zlUpd")).toBe("aaaa");
    fire({ type: "zl:engineUpdate", sha: "aaaa" });
    expect(reload).toHaveBeenCalledTimes(1);
    fire({ type: "zl:engineUpdate", sha: "bbbb" });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(store.get("zlUpd")).toBe("bbbb");
  });

  it("ignores non-update and malformed messages", () => {
    const { fire, reload } = mk();
    fire({ type: "zl:tabsOp", op: {} });
    fire({ type: "zl:engineUpdate" });
    fire(null);
    fire("string");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads even when storage throws (sandboxed frame)", () => {
    const { fire, reload } = mk({
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    } as unknown as Storage);
    fire({ type: "zl:engineUpdate", sha: "aaaa" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is inert without a serviceWorker container", () => {
    const w = { navigator: {}, location: { reload: vi.fn() } };
    expect(() => applyUpdateReload(w as unknown as Record<string, unknown>)).not.toThrow();
  });
});

describe("engine update worker module (#121)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("engineSha hashes the worker script (first 16 hex, zlswSha shape)", async () => {
    vi.stubGlobal("self", {
      location: { origin: "https://e.example" },
      registration: { active: { scriptURL: "https://e.example/sw.js" } },
    });
    vi.stubGlobal("fetch", async () => new Response("zeolite-bytes"));
    expect(await engineSha()).toBe("015ac4b2466d5827");
  });

  it("engineSha reports null on a non-200 fetch, never a guess", async () => {
    vi.stubGlobal("self", {
      location: { origin: "https://e.example" },
      registration: { active: { scriptURL: "https://e.example/sw.js" } },
    });
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    expect(await engineSha()).toBeNull();
  });

  it("broadcastEngineUpdate posts zl:engineUpdate to every window client", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("self", {
      location: { origin: "https://e.example" },
      registration: { active: { scriptURL: "https://e.example/sw.js" } },
      clients: {
        matchAll: async () => [
          { postMessage: (m: unknown) => void posted.push(m) },
          { postMessage: (m: unknown) => void posted.push(m) },
        ],
      },
    });
    vi.stubGlobal("fetch", async () => new Response("zeolite-bytes"));
    await broadcastEngineUpdate();
    expect(posted.length).toBe(2);
    expect(posted[0]).toEqual({
      type: "zl:engineUpdate",
      sha: "015ac4b2466d5827",
      version: ZEOLITE_VERSION,
    });
  });

  it("startUpdateChecks polls registration.update on boot and per interval", () => {
    const seen = { update: 0, listeners: 0 };
    vi.stubGlobal("self", {
      registration: {
        update: () => {
          seen.update++;
          return Promise.resolve();
        },
        addEventListener: () => {
          seen.listeners++;
        },
      },
    });
    vi.useFakeTimers();
    startUpdateChecks();
    expect(seen.update).toBe(1);
    expect(seen.listeners).toBe(1);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(seen.update).toBe(2);
    vi.useRealTimers();
  });
});
