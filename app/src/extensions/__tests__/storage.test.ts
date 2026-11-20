import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openDb } from "../idb";
import { ExtensionStorageArea } from "../storage";

function mkId(tag: string): string {
  return (tag + "0".repeat(32)).slice(0, 32);
}

async function freshArea(tag: string): Promise<ExtensionStorageArea> {
  const db = await openDb();
  const a = new ExtensionStorageArea(mkId(tag), "local", "local");
  await a.load(db);
  return a;
}

describe("ExtensionStorageArea", () => {
  it("round-trips values and reports changes", async () => {
    const a = await freshArea("rt");
    const changes: unknown[] = [];
    a.addListener((c) => changes.push(c));
    await a.set({ k: "v", n: 5 });
    expect(await a.get(["k", "n"])).toEqual({ k: "v", n: 5 });
    expect(changes).toHaveLength(1);
    await a.remove("k");
    expect(await a.get("k")).toEqual({});
  });
  it("honors get(null) = everything and defaults in get(object)", async () => {
    const a = await freshArea("gn");
    await a.set({ x: 1 });
    expect(await a.get(null)).toEqual({ x: 1 });
    expect(await a.get({ x: null, y: "def" })).toEqual({ x: 1, y: "def" });
  });
  it("persists across area instances (IndexedDB back end)", async () => {
    const a = await freshArea("pr");
    await a.set({ keep: true });
    const b = await freshArea("pr");
    expect(await b.get("keep")).toEqual({ keep: true });
  });
  it("rejects unserializable values", async () => {
    const a = await freshArea("us");
    const bad: unknown = {};
    (bad as Record<string, unknown>).self = bad;
    await expect(a.set({ bad })).rejects.toThrow(/serializable/);
  });
  it("session area is memory only", async () => {
    const db = await openDb();
    const s = new ExtensionStorageArea(mkId("se"), "session", "session");
    await s.load(db);
    await s.set({ m: 1 });
    const s2 = new ExtensionStorageArea(mkId("se"), "session", "session");
    await s2.load(db);
    expect(await s2.get("m")).toEqual({});
  });
});
