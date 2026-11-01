import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

/* #541: extension download handoff persistence. downloads.download()
   -> host zl:downloadState records write through to the extension DB's
   download-handoffs store and rehydrate on background boot. Only state
   is persisted (never file bytes); unfinished records recover honestly
   with a recoveredAt marker; terminal states are final; records older
   than the 7-day retention window are dropped. */

import { DownloadsHost, HANDOFF_RETENTION_MS, type DownloadState, type DownloadChange } from "../downloads";
import { openDb, idbDelete, idbGet, idbGetAllKeys, idbPut, resetDbForTests, STORE_HANDOFFS, STORE_META } from "../idb";
import { DIAG } from "../../diag";
import type { ExtensionRecord } from "../types";

const ext = (id: string): ExtensionRecord => ({ id, permissions: ["downloads"] }) as unknown as ExtensionRecord;

/* fake-indexeddb commits on microtasks; give the fire-and-forget
   write-throughs a macrotask to land. */
const flush = () => new Promise((r) => setTimeout(r, 5));

const diagEventsWith = (needle: string): number =>
  DIAG.snapshot(0).events.filter((e) => e.message.includes(needle)).length;

describe("handoff write-through (#541)", () => {
  it("persists the active record before download() resolves", async () => {
    const host = new DownloadsHost();
    const ops: unknown[] = [];
    host.setDispatch((op) => ops.push(op));
    const id = await host.download(ext("e1"), { url: "https://x.example/file.zip", filename: "f.zip" });
    const rec = (await idbGet(await openDb(), STORE_HANDOFFS, String(id))) as DownloadState;
    expect(rec).toMatchObject({ id, extId: "e1", status: "active", url: "https://x.example/file.zip", filename: "f.zip" });
    expect(rec.ended).toBeUndefined();
    expect(rec.recoveredAt).toBeUndefined();
  });

  it("persists progress and terminal transitions on every state report", async () => {
    const host = new DownloadsHost();
    host.setDispatch(() => {});
    const id = await host.download(ext("e1"), { url: "https://x.example/file.zip" });
    expect(host.applyState(id, "active", { received: 5, size: 10 })).toMatchObject({ delta: { status: "active", received: 5 } });
    await flush();
    let rec = (await idbGet(await openDb(), STORE_HANDOFFS, String(id))) as DownloadState;
    expect(rec.received).toBe(5);
    expect(rec.size).toBe(10);
    expect(rec.status).toBe("active");
    expect(host.applyState(id, "done", { received: 10 })).toMatchObject({ delta: { status: "done" } });
    await flush();
    rec = (await idbGet(await openDb(), STORE_HANDOFFS, String(id))) as DownloadState;
    expect(rec.status).toBe("done");
    expect(typeof rec.ended).toBe("number");
  });

  it("a storage failure is a bounded diagnostic, never a failed handoff", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        const req = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          req.onerror?.(new Event("error"));
        });
        return req;
      },
    });
    try {
      /* drop the cached connection so the stubbed open is the one used */
      resetDbForTests();
      const host = new DownloadsHost();
      host.setDispatch(() => {});
      const before = diagEventsWith("download handoff persistence failed");
      /* write-through fails; the handoff still resolves and answers */
      const id = await host.download(ext("e2"), { url: "https://x.example/y" });
      expect(id).toBeGreaterThan(0);
      expect(host.applyState(id, "done", {})).toMatchObject({ delta: { status: "done" } });
      await flush();
      expect(diagEventsWith("download handoff persistence failed")).toBeGreaterThan(before);
    } finally {
      vi.unstubAllGlobals();
      /* later tests reconnect to the real fake DB */
      resetDbForTests();
    }
  });
});

describe("handoff restart recovery (#541)", () => {
  it("restores records with recoveredAt on non-terminal states, none on terminal ones", async () => {
    const first = new DownloadsHost();
    first.setDispatch(() => {});
    const doneId = await first.download(ext("e3"), { url: "https://x.example/done.bin" });
    const liveId = await first.download(ext("e3"), { url: "https://x.example/live.bin" });
    first.applyState(doneId, "done", {});
    await flush();

    /* a NEW module instance, same fake IDB: the restart */
    const second = new DownloadsHost();
    await second.load();
    const rows = second.search(ext("e3"));
    expect(rows.length).toBe(2);
    const done = rows.find((r) => r.id === doneId)!;
    const live = rows.find((r) => r.id === liveId)!;
    expect(done.status).toBe("done");
    expect(done.recoveredAt).toBeUndefined();
    /* the host never reported a terminal state for liveId: it stays
       honestly active, no fake completion */
    expect(live.status).toBe("active");
    expect(typeof live.recoveredAt).toBe("number");
    /* ids stay unique: the next download starts past every restored id */
    second.setDispatch(() => {});
    const nextId = await second.download(ext("e3"), { url: "https://x.example/next.bin" });
    expect(nextId).toBeGreaterThan(doneId);
    expect(nextId).toBeGreaterThan(liveId);
  });

  it("the terminal state is final after recovery: no resurrection, one bounded diagnostic", async () => {
    const first = new DownloadsHost();
    first.setDispatch(() => {});
    const id = await first.download(ext("e4"), { url: "https://x.example/f.bin" });
    first.applyState(id, "done", {});
    await flush();
    const second = new DownloadsHost();
    await second.load();
    const before = diagEventsWith("terminal download state re-reported");
    expect(second.applyState(id, "done", {})).toBeNull();
    expect(second.applyState(id, "error", { error: "late" })).toBeNull();
    /* exactly ONE bounded diagnostic for this id, not one per report */
    expect(diagEventsWith("terminal download state re-reported")).toBe(before + 1);
  });

  it("does not double-complete when the host re-reports a terminal state after recovery", async () => {
    const first = new DownloadsHost();
    first.setDispatch(() => {});
    const id = await first.download(ext("e5"), { url: "https://x.example/g.bin" });
    await flush();
    const second = new DownloadsHost();
    await second.load();
    const deltas: unknown[] = [];
    second.onChanged("e5", (d) => deltas.push(d));
    /* the first post-recovery terminal report completes the handoff */
    const applied = second.applyState(id, "done", { received: 9 });
    expect(applied).not.toBeNull();
    second.notify("e5", applied!.delta);
    /* a second identical report is a no-op: no second delta, no resurrection */
    expect(second.applyState(id, "done", { received: 9 })).toBeNull();
    expect(deltas.length).toBe(1);
    await flush();
    const rec = (await idbGet(await openDb(), STORE_HANDOFFS, String(id))) as DownloadState;
    expect(rec.status).toBe("done");
  });

  it("onChanged still fires consistently across a restart", async () => {
    const first = new DownloadsHost();
    first.setDispatch(() => {});
    const id = await first.download(ext("e6"), { url: "https://x.example/h.bin" });
    first.applyState(id, "active", { received: 2 });
    await flush();
    const second = new DownloadsHost();
    await second.load();
    const deltas: DownloadChange[] = [];
    second.onChanged("e6", (d) => deltas.push(d));
    /* the SW applies the state, wakes the background, then notifies
       with the delta - the same flow after a restart */
    const applied = second.applyState(id, "done", { received: 4 });
    expect(applied).not.toBeNull();
    second.notify("e6", applied!.delta);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ id, status: "done", received: 4 });
  });

  it("drops records older than the retention window on load", async () => {
    const db = await openDb();
    const oldSt: DownloadState = {
      id: 9001,
      extId: "e-old",
      status: "active",
      url: "https://old.example/stale.bin",
      received: 0,
      started: Date.now() - HANDOFF_RETENTION_MS - 60_000,
    };
    const freshSt: DownloadState = {
      id: 9002,
      extId: "e-old",
      status: "active",
      url: "https://old.example/fresh.bin",
      received: 0,
      started: Date.now(),
    };
    await idbPut(db, STORE_HANDOFFS, "9001", oldSt);
    await idbPut(db, STORE_HANDOFFS, "9002", freshSt);
    const host = new DownloadsHost();
    await host.load();
    const rows = host.search(ext("e-old"));
    expect(rows.map((r) => r.id)).toEqual([9002]);
    /* the stale record is deleted from the store, not just skipped */
    await flush();
    expect(await idbGetAllKeys(await openDb(), STORE_HANDOFFS)).toContain("9002");
    expect(await idbGetAllKeys(await openDb(), STORE_HANDOFFS)).not.toContain("9001");
  });

  it("skips corrupted records instead of loading them", async () => {
    const db = await openDb();
    await idbPut(db, STORE_HANDOFFS, "garbage", { nope: true });
    const host = new DownloadsHost();
    await host.load();
    expect(host.search(ext("e-old")).length).toBeLessThanOrEqual(1);
    await idbDelete(db, STORE_HANDOFFS, "garbage");
  });
});
