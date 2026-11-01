import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { SCRIPTING, type ScriptingMessage } from "../scripting";
import { LISTENER_SOURCE } from "../scripting";
import { TABS } from "../tabs";

const enc = new TextEncoder();

/* #517: executeScript func injection, structured-cloneable args, the
   results handshake over the SW->page reply port, and the honest
   rejections. The dispatch seam is captured; the page side is
   simulated by answering the transferred port exactly once, which
   is precisely the protocol LISTENER_SOURCE implements. */

function pkg(name: string, hostPermissions: string[]): Map<string, Uint8Array> {
  return new Map([
    [
      "manifest.json",
      enc.encode(
        JSON.stringify({
          manifest_version: 3,
          name,
          version: "1.0",
          permissions: ["scripting"],
          host_permissions: hostPermissions,
        }),
      ),
    ],
    ["inject.js", enc.encode("1 + 1;")],
  ]);
}

async function apiFor(name: string, hostPermissions = ["<all_urls>"]) {
  /* The singleton: scripting's file reads resolve resources through
     the same manager the SW uses. Names are unique per test, so the
     content-derived ids never collide inside this file. */
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, hostPermissions));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage },
  );
  return { id, api };
}

interface Captured {
  msg: ScriptingMessage;
  port: MessagePort | null;
}

const capturedDispatch: Captured[] = [];

function captureDispatch(): void {
  SCRIPTING.setDispatch((msg, port) => {
    capturedDispatch.push({ msg, port });
  });
}

afterEach(() => {
  SCRIPTING.setDispatch(null);
  capturedDispatch.length = 0;
  TABS.syncFromUi([]);
  vi.useRealTimers();
});

function seedTab(): void {
  TABS.syncFromUi([{ id: 9, index: 9, url: "https://target.example/page", title: "t9", active: true }]);
}

describe("scripting.executeScript func injection (#517)", () => {
  it("serializes the function, transfers args, and resolves the page's results", async () => {
    seedTab();
    captureDispatch();
    const { id, api } = await apiFor("FuncInject");
    void id;
    const scripting = (api.browser.scripting as {
      executeScript: (inj: Record<string, unknown>) => Promise<Array<{ result?: unknown; error?: string; frameId: number }>>;
    });
    const p = scripting.executeScript({
      target: { tabId: 9 },
      func: (x: number) => ({ got: x * 2, even: x % 2 === 0 }),
      args: [21],
    });
    expect(capturedDispatch).toHaveLength(1);
    const { msg, port } = capturedDispatch[0];
    expect(msg.wantResult).toBe(true);
    expect(msg.func).toContain("got:");
    expect(msg.args).toEqual([21]);
    /* The page answers on the transferred port, exactly once. */
    port!.postMessage({ results: [{ result: { got: 42, even: true } }] });
    const results = await p;
    expect(results).toEqual([{ result: { got: 42, even: true }, frameId: 0 }]);
  });

  it("captures the file's completion value and delivers errors as entries", async () => {
    seedTab();
    captureDispatch();
    const { api } = await apiFor("FileInject");
    const scripting = api.browser.scripting as {
      executeScript: (inj: Record<string, unknown>) => Promise<Array<{ result?: unknown; error?: string; frameId: number }>>;
    };
    const p = scripting.executeScript({ target: { tabId: 9 }, files: ["/inject.js"] });
    /* File reads go through IndexedDB, so the dispatch lands a tick later. */
    await vi.waitFor(() => {
      if (capturedDispatch.length !== 1) throw new Error("dispatch not captured yet");
    });
    const { msg, port } = capturedDispatch[0];
    expect(msg.js).toEqual(["1 + 1;"]);
    expect(msg.func).toBeUndefined();
    port!.postMessage({ results: [{ result: 2 }, { error: "boom: reference error" }] });
    const results = await p;
    expect(results[0]).toEqual({ result: 2, frameId: 0 });
    expect(results[1]).toEqual({ error: "boom: reference error", frameId: 0 });
  });

  it("rejects when no scripting listener answers, instead of faking success", async () => {
    seedTab();
    captureDispatch();
    const { api } = await apiFor("SilentPage");
    /* Fake timers start AFTER the install so IndexedDB internals keep
       their real scheduling; only the 30s reply window is faked. */
    vi.useFakeTimers();
    const scripting = api.browser.scripting as {
      executeScript: (inj: Record<string, unknown>) => Promise<unknown>;
    };
    const p = scripting.executeScript({ target: { tabId: 9 }, func: () => 1 });
    const expectation = expect(p).rejects.toThrow(/no scripting listener answered/);
    await vi.advanceTimersByTimeAsync(30000);
    await expectation;
  });
});

describe("scripting.executeScript validation (#517)", () => {
  it("rejects files+func, neither, non-serializable args, bad func, frame targeting and non-page worlds", async () => {
    seedTab();
    captureDispatch();
    const { api } = await apiFor("Validate");
    const scripting = api.browser.scripting as {
      executeScript: (inj: Record<string, unknown>) => Promise<unknown>;
      insertCSS: (inj: Record<string, unknown>) => Promise<void>;
    };
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, files: ["/inject.js"], func: () => 1 }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(scripting.executeScript({ target: { tabId: 9 } })).rejects.toThrow(/requires files or func/);
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, func: () => 1, args: [() => "nope"] }),
    ).rejects.toThrow(/args must be structured-cloneable/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, func: () => 1, args: [cyclic] }),
    ).rejects.toThrow(/structured-cloneable/);
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, func: () => 1, args: [undefined] }),
    ).rejects.toThrow(/structured-cloneable/);
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, func: 42 as unknown as () => void }),
    ).rejects.toThrow(/func must be a function/);
    await expect(
      scripting.executeScript({ target: { tabId: 9, allFrames: true }, files: ["/inject.js"] }),
    ).rejects.toThrow(/frame targeting/);
    await expect(
      scripting.executeScript({ target: { tabId: 9, frameIds: [0] }, files: ["/inject.js"] }),
    ).rejects.toThrow(/frame targeting/);
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, files: ["/inject.js"], world: "USER_SCRIPT" }),
    ).rejects.toThrow(/world/);
    await expect(scripting.insertCSS({ target: { tabId: 9 }, func: () => 1 })).rejects.toThrow(
      /does not run scripts/,
    );
    await expect(
      scripting.executeScript({ target: { tabId: 999 }, files: ["/inject.js"] }),
    ).rejects.toThrow(/Invalid tab ID/);
    expect(capturedDispatch).toHaveLength(0);
  });

  it("keeps the permission boundary: no host permission, no injection", async () => {
    seedTab();
    captureDispatch();
    const { api } = await apiFor("NoHost", []);
    const scripting = api.browser.scripting as {
      executeScript: (inj: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(
      scripting.executeScript({ target: { tabId: 9 }, files: ["/inject.js"] }),
    ).rejects.toThrow(/host permission/);
    expect(capturedDispatch).toHaveLength(0);
  });
});

describe("LISTENER_SOURCE reply protocol (#517)", () => {
  it("answers the transferred port once with results and keeps the trust checks", () => {
    expect(LISTENER_SOURCE).toContain("ev.ports[0].postMessage({ results: out })");
    expect(LISTENER_SOURCE).toContain("if (ev.source !== ctl) return;");
    expect(LISTENER_SOURCE).toContain("if (m.dest !== dest) return;");
    expect(LISTENER_SOURCE).toContain("runFunc");
  });
});
