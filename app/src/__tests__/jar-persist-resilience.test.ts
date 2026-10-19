import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIAG } from "../diag";
import { applySetCookie, cookiesResetForTests, flushJarPersist } from "../cookies";

/* #254: persistence failures surface as a STORAGE diag and the
   flush never throws, so a dead storage layer degrades honestly
   instead of wedging control-plane acks. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

describe("resilient jar persistence (#254)", () => {
  it("flushJarPersist survives a storage failure and surfaces a STORAGE diag", async () => {
    const g = globalThis as { indexedDB?: unknown };
    const real = g.indexedDB;
    g.indexedDB = {
      open: () => {
        throw new Error("storage gone");
      },
    };
    const emit = vi.spyOn(DIAG, "emit").mockImplementation(() => undefined);
    let sawStorageDiag = false;
    try {
      applySetCookie("https://s.example/", resp(["s=1"]));
      await expect(flushJarPersist()).resolves.toBeUndefined();
      /* read before mockRestore: restoring clears the call log */
      sawStorageDiag = emit.mock.calls.some(([e]) => e.category === "STORAGE" && e.severity === "error");
    } finally {
      emit.mockRestore();
      g.indexedDB = real;
    }
    expect(sawStorageDiag).toBe(true);
  });
});
