import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie } from "../cookies";

/* #614: the Rust/WASM jar arm inside cookies.ts. The glue loader is
   mocked (its fail-safe contract lives in cookieswasm.test.ts); only
   the module's own logic runs: the one-shot cutover, the per-seam
   dispatch, the outcome-to-SetCookieResult mapping with its DIAG and
   trace parity, and the TS fallback when the glue fails. */

const cap = vi.hoisted(() => ({
  fail: null as string | null,
  psl: null as ((d: string) => boolean) | null,
  storeOutcomes: [] as unknown[],
  matchRequestJson: JSON.stringify({ matched: [], purged: [] }),
  matchDocumentJson: "[]",
  sweepJson: "[]",
  exportNsJson: "[]",
  exportAllJson: "{}",
  removeCount: 0,
  mergeJson: JSON.stringify({ jars: 0, cookies: 0, conflicts: 0 }),
  clearNsJson: JSON.stringify({ jars: 0, cookies: 0 }),
  clearBucketCount: 0,
  calls: [] as Array<{ op: string; args: unknown[] }>,
}));

vi.mock("../cookieswasm", () => ({
  initCookiesWasmGlue: async () => {
    if (cap.fail) throw new Error(cap.fail);
    return {
      setPsl: (f: (d: string) => boolean) => { cap.psl = f; cap.calls.push({ op: "setPsl", args: [] }); },
      storeBatch: (ns: string, bucket: string, originUrl: string, headersJson: string, fromScript: boolean, now: number) => {
        cap.calls.push({ op: "storeBatch", args: [ns, bucket, originUrl, JSON.parse(headersJson), fromScript, typeof now === "number"] });
        return JSON.stringify(cap.storeOutcomes);
      },
      matchRequest: (ns: string, requestUrl: string) => { cap.calls.push({ op: "matchRequest", args: [ns, requestUrl] }); return cap.matchRequestJson; },
      matchDocument: (ns: string, pageUrl: string) => { cap.calls.push({ op: "matchDocument", args: [ns, pageUrl] }); return cap.matchDocumentJson; },
      sweep: (ns: string) => { cap.calls.push({ op: "sweep", args: [ns] }); return cap.sweepJson; },
      removeIdentities: (ns: string, idsJson: string) => { cap.calls.push({ op: "removeIdentities", args: [ns, JSON.parse(idsJson)] }); return cap.removeCount; },
      exportNs: (ns: string) => { cap.calls.push({ op: "exportNs", args: [ns] }); return cap.exportNsJson; },
      exportAll: () => { cap.calls.push({ op: "exportAll", args: [] }); return cap.exportAllJson; },
      replaceNs: (ns: string, entriesJson: string) => { cap.calls.push({ op: "replaceNs", args: [ns, JSON.parse(entriesJson)] }); return 0; },
      mergeNs: (ns: string, entriesJson: string, rule: string) => { cap.calls.push({ op: "mergeNs", args: [ns, JSON.parse(entriesJson), rule] }); return cap.mergeJson; },
      clearNs: (ns: string) => { cap.calls.push({ op: "clearNs", args: [ns] }); return cap.clearNsJson; },
      clearBucket: (ns: string, bucket: string) => { cap.calls.push({ op: "clearBucket", args: [ns, bucket] }); return cap.clearBucketCount; },
      clearAll: () => { cap.calls.push({ op: "clearAll", args: [] }); },
      default: async () => undefined,
    };
  },
}));

vi.mock("../diag", () => ({ DIAG: { emit: vi.fn(), failure: vi.fn(), trace: () => "trace" } }));
vi.mock("../tracing", () => ({ traceDecision: vi.fn() }));

type Cm = typeof import("../cookies");

function ck(name: string, value = "v"): Cookie {
  return { name, value, domain: "a.example", hostOnly: true, path: "/", secure: true, httpOnly: false, sameSite: "lax", expires: 0, created: 123 };
}

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

let cm: Cm;
let emit: ReturnType<typeof vi.fn>;
let trace: ReturnType<typeof vi.fn>;

async function fresh(): Promise<void> {
  vi.resetModules();
  const g = (await import("../cookies")) as Cm;
  const d = await import("../diag");
  const t = await import("../tracing");
  emit = d.DIAG.emit as unknown as ReturnType<typeof vi.fn>;
  trace = t.traceDecision as unknown as ReturnType<typeof vi.fn>;
  g.cookiesResetForTests();
  cm = g;
}

function ops(name: string): Array<{ op: string; args: unknown[] }> {
  return cap.calls.filter((c) => c.op === name);
}

beforeEach(async () => {
  cap.fail = null;
  cap.psl = null;
  cap.storeOutcomes = [];
  cap.matchRequestJson = JSON.stringify({ matched: [], purged: [] });
  cap.matchDocumentJson = "[]";
  cap.sweepJson = "[]";
  cap.exportNsJson = "[]";
  cap.exportAllJson = "{}";
  cap.removeCount = 0;
  cap.mergeJson = JSON.stringify({ jars: 0, cookies: 0, conflicts: 0 });
  cap.clearNsJson = JSON.stringify({ jars: 0, cookies: 0 });
  cap.clearBucketCount = 0;
  await fresh();
  cap.calls.length = 0;
});

afterEach(() => {
  cm.cookiesResetForTests();
});

describe("cookies wasm arm cutover and dispatch (#614)", () => {
  it("cuts over live TS jars by namespace and injects the PSL", async () => {
    const id = cm.registerOrigin("https://a.example").id;
    cm.applySetCookie("https://a.example/", resp(["k=1"]));
    cap.calls.length = 0;
    await cm.initCookiesWasm();
    expect(typeof cap.psl).toBe("function");
    expect(cap.psl?.("co.uk")).toBe(true);
    expect(cap.psl?.("a.example")).toBe(false);
    const reps = ops("replaceNs");
    expect(reps).toHaveLength(1);
    expect(reps[0].args[0]).toBe("default");
    const entries = reps[0].args[1] as Array<[string, Cookie[]]>;
    expect(entries[0][0]).toBe(id);
    expect(entries[0][1][0].name).toBe("k");
    /* the wasm arm now answers admission */
    cap.storeOutcomes = [{ name: "k", stored: true, deleted: false, cookie: ck("k"), replaced: false, evicted: [] }];
    const rs = cm.applySetCookie("https://a.example/", resp(["k=2"]));
    expect(ops("storeBatch")).toHaveLength(1);
    expect(rs[0].stored).toBe(true);
  });

  it("maps a stored wasm outcome onto SetCookieResult with the jar-change seam", async () => {
    await cm.initCookiesWasm();
    const changes: unknown[] = [];
    cm.onCookieJarChange((c) => changes.push(c));
    cap.storeOutcomes = [{ name: "k", stored: true, deleted: false, cookie: ck("k"), replaced: true, evicted: [ck("old")] }];
    const rs = cm.applySetCookie("https://a.example/", resp(["k=1"]));
    expect(rs[0]).toMatchObject({ name: "k", stored: true, deleted: false, replaced: true, namespace: "default" });
    expect(rs[0].cookie?.value).toBe("v");
    const sb = ops("storeBatch")[0];
    expect(sb.args[0]).toBe("default");
    expect(sb.args[1]).toBe(cm.registerOrigin("https://a.example").id);
    expect(sb.args[3]).toEqual(["k=1"]);
    expect(sb.args[4]).toBe(false);
    /* the stored admission plus the admission-sweep eviction both ride the seam */
    expect(changes).toHaveLength(2);
  });

  it("maps a rejected wasm outcome with the TS DIAG row", async () => {
    await cm.initCookiesWasm();
    cap.storeOutcomes = [{ name: "", stored: false, deleted: false, rejected: "malformed" }];
    const rs = cm.applySetCookie("https://a.example/", resp(["garbage"]));
    expect(rs[0]).toMatchObject({ stored: false, deleted: false, rejected: "malformed" });
    expect(
      emit.mock.calls.some((c: unknown[]) => (c[0] as { message?: string }).message === "set-cookie rejected: malformed"),
    ).toBe(true);
  });

  it("maps a deleted wasm outcome with the removed cookie view", async () => {
    await cm.initCookiesWasm();
    cap.storeOutcomes = [{ name: "k", stored: false, deleted: true, cookie: ck("k") }];
    const rs = cm.applySetCookie("https://a.example/", resp(["k=; Max-Age=0"]));
    expect(rs[0]).toMatchObject({ stored: false, deleted: true, replaced: true });
    expect(rs[0].cookie?.name).toBe("k");
  });

  it("maps a no-op wasm outcome without a rejection field", async () => {
    await cm.initCookiesWasm();
    cap.storeOutcomes = [{ name: "k", stored: false, deleted: false }];
    const rs = cm.applySetCookie("https://a.example/", resp(["k=1"]));
    expect(rs[0]).toMatchObject({ name: "k", stored: false, deleted: false });
    expect(rs[0].rejected).toBeUndefined();
  });

  it("serves request headers from matchRequest and refuses unbound clients", async () => {
    await cm.initCookiesWasm();
    cap.matchRequestJson = JSON.stringify({ matched: [ck("k"), ck("j", "w")], purged: [] });
    expect(cm.cookieHeaderFor("https://a.example/x")).toBe("k=v; j=w");
    const mr = ops("matchRequest")[0];
    expect(mr.args[0]).toBe("default");
    expect(mr.args[1]).toBe("https://a.example/x");
    /* #366: explicitly unbound clients get no header and no wasm call */
    cap.calls.length = 0;
    cm.setJarProfile("work", "root1");
    cm.markJarClientUnbound("c-unbound");
    expect(cm.cookieHeaderFor("https://a.example/x", { clientId: "c-unbound" })).toBeNull();
    expect(ops("matchRequest")).toHaveLength(0);
  });

  it("serves document.cookie reads from matchDocument", async () => {
    await cm.initCookiesWasm();
    cap.matchDocumentJson = JSON.stringify([ck("k"), ck("j", "w")]);
    expect(cm.documentCookieRead("https://a.example/")).toBe("k=v; j=w");
    expect(ops("matchDocument")[0].args[0]).toBe("default");
  });

  it("dispatches jarRemoveIdentities with api-removed traces", async () => {
    await cm.initCookiesWasm();
    cap.removeCount = 2;
    const ids = [{ name: "k", domain: "a.example", hostOnly: true, path: "/" }];
    expect(cm.jarRemoveIdentities(ids)).toBe(2);
    expect(ops("removeIdentities")[0].args[1]).toEqual(ids);
    expect(
      trace.mock.calls.some((c: unknown[]) => (c[0] as { result?: string }).result === "api-removed k"),
    ).toBe(true);
  });

  it("clones jarSnapshot from exportNs", async () => {
    await cm.initCookiesWasm();
    cap.exportNsJson = JSON.stringify([["id1", [ck("k")]]]);
    const snap = cm.jarSnapshot();
    expect(snap.get("id1")).toHaveLength(1);
    expect(snap.get("id1")?.[0].name).toBe("k");
    /* cloned: mutating the snapshot never reaches the next read */
    const list = snap.get("id1");
    if (list) list[0].name = "mutated";
    expect(cm.jarSnapshot().get("id1")?.[0].name).toBe("k");
  });

  it("enumerates the active namespace for a client and every namespace globally", async () => {
    await cm.initCookiesWasm();
    cap.exportNsJson = JSON.stringify([["id1", [ck("k")]]]);
    const view = cm.jarEnumeration("client:unknown:1");
    expect(ops("exportNs")).toHaveLength(1);
    expect(view).toHaveLength(1);
    expect(view[0].cookies).toBe(1);
    cap.exportAllJson = JSON.stringify({ default: [["id1", [ck("k")]]], "client:root1:sess1": [["id2", [ck("j", "w")]]] });
    const all = cm.jarEnumeration();
    expect(ops("exportAll")).toHaveLength(1);
    expect(all.reduce((n, p) => n + p.cookies, 0)).toBe(2);
  });

  it("enumerates the default profile with origin names", async () => {
    await cm.initCookiesWasm();
    const id = cm.registerOrigin("https://a.example").id;
    cap.exportNsJson = JSON.stringify([[id, [ck("k")]]]);
    const v = cm.jarDefaultEnumeration();
    expect(v).toHaveLength(1);
    expect(v[0].origins[0].origin).toBe("https://a.example");
    expect(v[0].cookies).toBe(1);
  });

  it("clears a whole namespace or one bucket through the wasm arm", async () => {
    await cm.initCookiesWasm();
    cap.clearNsJson = JSON.stringify({ jars: 2, cookies: 5 });
    expect(cm.jarClearScope("default", undefined)).toEqual({ ok: true, jars: 2, cookies: 5 });
    expect(ops("clearNs")[0].args[0]).toBe("default");
    const id = cm.registerOrigin("https://a.example").id;
    cap.clearBucketCount = 3;
    expect(cm.jarClearScope("default", "https://a.example")).toEqual({ ok: true, jars: 1, cookies: 3 });
    expect(ops("clearBucket")[0].args[1]).toBe(id);
  });

  it("filters jarReplace records before the wasm import", async () => {
    await cm.initCookiesWasm();
    cm.jarReplace([["", [ck("bad")]], ["good", [ck("k"), { junk: true }]], ["empty", []]]);
    const rp = ops("replaceNs")[0];
    expect(rp.args[0]).toBe("default");
    const entries = rp.args[1] as Array<[string, Cookie[]]>;
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("good");
    expect(entries[0][1]).toHaveLength(1);
  });

  it("dispatches jarMerge with the conflict rule passthrough", async () => {
    await cm.initCookiesWasm();
    cap.mergeJson = JSON.stringify({ jars: 1, cookies: 2, conflicts: 1 });
    const r = cm.jarMerge([["good", [ck("k")]]], "keep-existing");
    expect(r).toEqual({ jars: 1, cookies: 2, conflicts: 1 });
    expect(ops("mergeNs")[0].args[2]).toBe("keep-existing");
  });

  it("keeps the TS arm when the glue fails", async () => {
    cap.fail = "glue dead";
    await expect(cm.initCookiesWasm()).rejects.toBeTruthy();
    const rs = cm.applySetCookie("https://a.example/", resp(["k=1"]));
    expect(rs[0].stored).toBe(true);
    expect(ops("storeBatch")).toHaveLength(0);
    expect(cm.cookieHeaderFor("https://a.example/x")).toBe("k=1");
    expect(ops("matchRequest")).toHaveLength(0);
  });

  it("hands a restored record back to the wasm registry on jarLoad", async () => {
    await cm.initCookiesWasm();
    const id = cm.registerOrigin("https://a.example").id;
    cap.exportNsJson = JSON.stringify([[id, [ck("k")]]]);
    await cm.jarPersist();
    cap.calls.length = 0;
    await cm.jarLoad();
    expect(ops("clearAll")).toHaveLength(1);
    const reps = ops("replaceNs");
    expect(reps).toHaveLength(1);
    expect(reps[0].args[0]).toBe("default");
    expect((reps[0].args[1] as Array<[string, Cookie[]]>)[0][1][0].name).toBe("k");
  });
});
