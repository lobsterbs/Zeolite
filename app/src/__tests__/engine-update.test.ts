import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUpdateNotice } from "../bootstrap/update";
import { broadcastEngineUpdate, engineSha, startUpdateChecks } from "../updates";
import { ZEOLITE_VERSION } from "../swstate";

/* #121: stale-engine alerting. The bootstrap listener logs a console
   note and re-dispatches a window CustomEvent once per engine sha; it
   never reloads (refresh-spam rule: reloads are user-initiated).
   The worker module hashes its own script, broadcasts
   zl:engineUpdate to window clients and polls registration.update(). */

describe("applyUpdateNotice (#121 bootstrap)", () => {
  const mk = (storage?: Storage) => {
    const store = new Map<string, string>();
    const info = vi.fn();
    const reload = vi.fn();
    const dispatched: unknown[] = [];
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
      console: { info },
      dispatchEvent: (e: unknown) => {
        dispatched.push(e);
        return true;
      },
      location: { reload },
    };
    applyUpdateNotice(w as unknown as Record<string, unknown>);
    return {
      fire: (d: unknown) => handler!({ data: d } as MessageEvent),
      info,
      reload,
      dispatched,
      store,
    };
  };

  it("notifies once per engine sha and skips replays of the same sha", () => {
    const { fire, info, dispatched, store } = mk();
    fire({ type: "zl:engineUpdate", sha: "aaaa", version: "1.2.3" });
    expect(info).toHaveBeenCalledTimes(1);
    expect(store.get("zlUpd")).toBe("aaaa");
    expect(dispatched).toHaveLength(1);
    const ev = dispatched[0] as CustomEvent;
    expect(ev.type).toBe("zl:engineUpdate");
    expect(ev.detail).toEqual({ sha: "aaaa", version: "1.2.3" });
    fire({ type: "zl:engineUpdate", sha: "aaaa", version: "1.2.3" });
    expect(info).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    fire({ type: "zl:engineUpdate", sha: "bbbb", version: "1.2.3" });
    expect(info).toHaveBeenCalledTimes(2);
    expect(store.get("zlUpd")).toBe("bbbb");
  });

  it("never reloads the page (refresh-spam rule)", () => {
    const { fire, reload } = mk();
    fire({ type: "zl:engineUpdate", sha: "aaaa", version: "1.2.3" });
    fire({ type: "zl:engineUpdate", sha: "bbbb", version: "1.2.3" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores non-update and malformed messages", () => {
    const { fire, info, dispatched } = mk();
    fire({ type: "zl:tabsOp", op: {} });
    fire({ type: "zl:engineUpdate" });
    fire(null);
    fire("string");
    expect(info).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("notifies even when storage throws (sandboxed frame)", () => {
    const { fire, info } = mk({
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    } as unknown as Storage);
    fire({ type: "zl:engineUpdate", sha: "aaaa", version: "1.2.3" });
    expect(info).toHaveBeenCalledTimes(1);
    /* no storage = no zlUpd guard, so the page-lifetime lastSha guard
       must cap repeat broadcasts of the same sha */
    fire({ type: "zl:engineUpdate", sha: "aaaa", version: "1.2.3" });
    expect(info).toHaveBeenCalledTimes(1);
    fire({ type: "zl:engineUpdate", sha: "bbbb", version: "1.2.3" });
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("is inert without a serviceWorker container", () => {
    const w = { navigator: {}, location: { reload: vi.fn() } };
    expect(() => applyUpdateNotice(w as unknown as Record<string, unknown>)).not.toThrow();
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
