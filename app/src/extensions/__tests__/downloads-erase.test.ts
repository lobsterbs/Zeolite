import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

/* Extension downloads member slice: erase over the durable handoff
   registry, plus the onCreated/onErased events. MDN semantics:
   erase() erases matching download history records without touching
   the saved files and resolves with the erased ids array; onCreated
   fires with the DownloadItem when download() succeeds; onErased
   fires with the erased downloadId. Engine honesty: only terminal
   handoff records are erasable - the host owns the live transfer and
   an active record cannot be orphaned mid-flight - matching the
   browsingData.removeDownloads precedent. */

import { DownloadsHost } from "../downloads";
import { openDb, idbGet, resetDbForTests, STORE_HANDOFFS } from "../idb";
import type { ExtensionRecord } from "../types";

const ext = (id: string): ExtensionRecord => ({ id, permissions: ["downloads"] }) as unknown as ExtensionRecord;

const flush = () => new Promise((r) => setTimeout(r, 5));

async function handoff(host: DownloadsHost, owner: ExtensionRecord, url: string, status: "done" | "active"): Promise<number> {
  host.setDispatch(() => {});
  const id = await host.download(owner, { url });
  if (status === "done") host.applyState(id, "done");
  return id;
}

describe("downloads.erase (member slice)", () => {
  afterEach(async () => {
    await resetDbForTests();
  });

  it("erases terminal handoff records, resolves with their ids, deletes the persisted rows, and fires onErased", async () => {
    const host = new DownloadsHost();
    const acc = ext("e1");
    const id1 = await handoff(host, acc, "https://x.example/a", "done");
    const id2 = await handoff(host, acc, "https://x.example/b", "done");
    const id3 = await handoff(host, acc, "https://x.example/c", "active");
    const seen: number[] = [];
    host.onErased("e1", (downloadId) => seen.push(downloadId));
    const erased = await host.erase(acc, {});
    expect(erased).toEqual([id1, id2].sort((a, b) => a - b));
    expect(erased).not.toContain(id3);
    expect(seen).toEqual(erased);
    expect(host.search(acc).map((s) => s.id)).toEqual([id3]);
    await flush();
    const db = await openDb();
    expect(await idbGet(db, STORE_HANDOFFS, String(id1))).toBeUndefined();
    expect(await idbGet(db, STORE_HANDOFFS, String(id2))).toBeUndefined();
  });

  it("supports the id and limit filters of the query surface", async () => {
    const host = new DownloadsHost();
    const acc = ext("e1");
    const idA = await handoff(host, acc, "https://x.example/a", "done");
    const idB = await handoff(host, acc, "https://x.example/b", "done");
    expect(await host.erase(acc, { id: idB })).toEqual([idB]);
    const idC = await handoff(host, acc, "https://x.example/c", "done");
    const idD = await handoff(host, acc, "https://x.example/d", "done");
    /* idA is still erasable, so limit picks the lowest id first. */
    expect(await host.erase(acc, { limit: 1 })).toEqual([idA]);
    expect(await host.erase(acc, {})).toEqual([idC, idD]);
  });

  it("does not erase another extension's handoffs and refuses without the permission", async () => {
    const host = new DownloadsHost();
    const idForeign = await handoff(host, ext("e1"), "https://x.example/f", "done");
    expect(await host.erase(ext("e2"), {})).toEqual([]);
    const bare = { id: "e3", permissions: [] } as unknown as ExtensionRecord;
    await expect(host.erase(bare, {})).rejects.toThrow(/permission/);
    expect(idForeign).toBeGreaterThan(0);
  });
});

describe("downloads.onCreated (member slice)", () => {
  afterEach(async () => {
    await resetDbForTests();
  });

  it("fires with the DownloadItem when download() resolves, to the owner only", async () => {
    const host = new DownloadsHost();
    const items: { id: number; status: string; url: string }[] = [];
    host.onCreated("e1", (item) => items.push(item));
    host.setDispatch(() => {});
    const id = await host.download(ext("e1"), { url: "https://x.example/z" });
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(id);
    expect(items[0].status).toBe("active");
    expect(items[0].url).toBe("https://x.example/z");
    /* another extension's listener never hears it */
    const heard2: unknown[] = [];
    host.onCreated("e2", (item) => heard2.push(item));
    await host.download(ext("e1"), { url: "https://x.example/y" });
    expect(heard2.length).toBe(0);
    expect(items.length).toBe(2);
  });
});
