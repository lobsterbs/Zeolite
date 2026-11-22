import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { HISTORY } from "../history";
import type { ExtensionRecord } from "../types";

/* #520: browser.history / browser.topSites over the engine's real
   visit store. The manager singleton persists extensions per manifest
   hash within one test run, so every install uses a fresh random
   suffix; the tests plant visits through the store seam or addUrl and
   only ever assert on their own URLs. */

const enc = new TextEncoder();

function pkg(name: string, perms: string[]): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: perms };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

async function install(
  name: string,
  perms: string[],
): Promise<{ rec: ExtensionRecord; api: { browser: Record<string, unknown>; chrome: Record<string, unknown> } }> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name + Math.random().toString(36).slice(2, 7), perms));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  return {
    rec,
    api: buildApi(
      rec,
      { extensionId: id, context: "background", url: null } as never,
      { messenger: new ExtensionMessenger(), storage, manager: extensions } as never,
    ),
  };
}

describe("history over the real visit store (#520)", () => {
  it("mounts only with the history/topSites permissions", async () => {
    const bare = await install("HistBare", []);
    expect(bare.api.browser.history).toBeUndefined();
    expect(bare.api.browser.topSites).toBeUndefined();
    const hist = await install("HistExt", ["history"]);
    expect(hist.api.browser.history).toBeTruthy();
    expect(hist.api.browser.topSites).toBeUndefined();
    const top = await install("TopExt", ["topSites"]);
    expect(top.api.browser.topSites).toBeTruthy();
    expect(top.api.browser.history).toBeUndefined();
  });

  it("addUrl records, search answers, getVisits returns the visit ring", async () => {
    const { api } = await install("HistSearch", ["history"]);
    const h = api.browser.history as Record<string, unknown>;
    const url = "https://hist-a.example/page";
    await (h.addUrl as (d: Record<string, unknown>) => Promise<void>)({ url });
    const found = await (h.search as (q: Record<string, unknown>) => Promise<
      Array<{ id: number; url: string; visitCount: number; lastVisitTime: number }>
    >)({ text: "hist-a.example" });
    const row = found.find((x) => x.url === url);
    expect(row, "search finds the added url").toBeTruthy();
    expect(row!.visitCount).toBeGreaterThanOrEqual(1);
    expect(typeof row!.id).toBe("number");
    expect(typeof row!.lastVisitTime).toBe("number");
    const visits = await (h.getVisits as (d: Record<string, unknown>) => Promise<
      Array<{ visitTime: number }>
    >)({ url });
    expect(visits.length).toBeGreaterThanOrEqual(1);
    expect(typeof visits[0].visitTime).toBe("number");
  });

  it("onVisited fires from addUrl, onVisitRemoved from deleteUrl", async () => {
    const { api } = await install("HistEvents", ["history"]);
    const h = api.browser.history as Record<string, unknown>;
    const url = "https://hist-b.example/x";
    const seen: Array<{ url: string }> = [];
    const deleted: Array<{ allHistory: boolean; urls: string[] }> = [];
    const lv = (x: { url: string }) => seen.push(x);
    const ld = (x: { allHistory: boolean; urls: string[] }) => deleted.push(x);
    (h.onVisited as { addListener: (l: (x: { url: string }) => void) => void }).addListener(lv);
    (h.onVisitRemoved as { addListener: (l: (x: { allHistory: boolean; urls: string[] }) => void) => void }).addListener(ld);
    await (h.addUrl as (d: Record<string, unknown>) => Promise<void>)({ url });
    expect(seen.some((x) => x.url === url)).toBe(true);
    await (h.deleteUrl as (d: Record<string, unknown>) => Promise<void>)({ url });
    const hit = deleted.find((x) => x.urls.includes(url));
    expect(hit, "onVisitRemoved fires with the deleted url").toBeTruthy();
    expect(hit!.allHistory).toBe(false);
    (h.onVisited as { removeListener: (l: unknown) => void }).removeListener(lv);
    (h.onVisitRemoved as { removeListener: (l: unknown) => void }).removeListener(ld);
  });

  it("deleteRange prunes the window, deleteAll reports allHistory, arg shapes reject", async () => {
    const { api } = await install("HistRange", ["history"]);
    const h = api.browser.history as Record<string, unknown>;
    const base = 1_700_000_000_000;
    const inWindow = "https://hist-c.example/in";
    const survivor = "https://hist-c.example/out";
    /* Plant through the store seam so the visit times are exact. */
    HISTORY.noteVisit(inWindow, base);
    HISTORY.noteVisit(survivor, base + 10 * 60_000);
    const removed: Array<{ allHistory: boolean; urls: string[] }> = [];
    const ld = (x: { allHistory: boolean; urls: string[] }) => removed.push(x);
    (h.onVisitRemoved as { addListener: (l: (x: { allHistory: boolean; urls: string[] }) => void) => void }).addListener(ld);
    await expect((h.deleteRange as (d: Record<string, unknown>) => Promise<void>)({ startTime: base - 1 })).rejects.toThrow();
    await expect((h.getVisits as (d: Record<string, unknown>) => Promise<unknown>)({})).rejects.toThrow();
    await expect((h.addUrl as (d: Record<string, unknown>) => Promise<void>)({})).rejects.toThrow();
    await expect((h.deleteUrl as (d: Record<string, unknown>) => Promise<void>)({})).rejects.toThrow();
    await (h.deleteRange as (d: Record<string, unknown>) => Promise<void>)({ startTime: base - 1, endTime: base + 1 });
    const urls = (await (h.search as (q: Record<string, unknown>) => Promise<Array<{ url: string }>>)({ text: "hist-c.example" })).map((x) => x.url);
    expect(urls).toContain(survivor);
    expect(urls).not.toContain(inWindow);
    await (h.deleteAll as () => Promise<void>)();
    expect(removed.some((x) => x.allHistory === true)).toBe(true);
    expect(await (h.search as (q: Record<string, unknown>) => Promise<unknown[]>)({ text: "hist-c.example" })).toEqual([]);
    (h.onVisitRemoved as { removeListener: (l: unknown) => void }).removeListener(ld);
  });
});

describe("topSites ranks the real visit store (#520)", () => {
  it("get orders by visit count then recency and honors the limit", async () => {
    const { api } = await install("TopRank", ["topSites"]);
    const ts = api.browser.topSites as Record<string, unknown>;
    const base = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) HISTORY.noteVisit("https://hist-top.example/popular", base + i);
    HISTORY.noteVisit("https://hist-top.example/once", base + 100);
    const rows = await (ts.get as (d?: Record<string, unknown>) => Promise<
      Array<{ title: string; url: string }>
    >)();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    /* The engine has no titles, so entries carry the empty title - no
       id/visitCount leaks. */
    expect(rows[0]).toEqual({ title: "", url: "https://hist-top.example/popular" });
    const one = await (ts.get as (d?: Record<string, unknown>) => Promise<unknown[]>)({ limit: 1 });
    expect(one.length).toBe(1);
  });
});
