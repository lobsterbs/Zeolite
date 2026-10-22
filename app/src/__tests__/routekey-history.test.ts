import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { loadRouteHistory, loadRouteKey, saveRouteKey } from "../routekey";

/* #399: a transient storage failure is not first boot.
   loadRouteHistory must answer null (the caller keeps its in-memory
   keys and retries) instead of [] (the caller would mint a fresh
   key and strand every route minted before the restart). */

describe("route key storage (#399)", () => {
  it("answers null, not [], when storage fails", async () => {
    const g = globalThis as { indexedDB?: unknown };
    const real = g.indexedDB;
    g.indexedDB = {
      open: () => {
        throw new Error("storage gone");
      },
    };
    try {
      await expect(loadRouteHistory()).resolves.toBeNull();
      await expect(loadRouteKey()).resolves.toBeNull();
    } finally {
      g.indexedDB = real;
    }
  });

  it("answers [] only on a genuine first boot, and the history after a save", async () => {
    await expect(loadRouteHistory()).resolves.toEqual([]);
    const k = new Uint8Array(16).map((_, i) => i + 1);
    await saveRouteKey(k);
    await expect(loadRouteHistory()).resolves.toEqual([k]);
    await expect(loadRouteKey()).resolves.toEqual(k);
  });
});
