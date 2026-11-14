/* #516 slice 3: the argument-schema contract (arg-schemas.ts) held
   against the real mounted surface.

   Invariants:
   1. every ARG_SCHEMAS path resolves to a mounted function on the
      all-permissions surface (no stale entries, no silently skipped
      paths that should mount),
   2. every mounted method of the five covered namespaces (alarms,
      cookies, runtime, tabs, and the three storage areas) has a
      schema - a new method without one fails here,
   3. out-of-contract calls (wrong arity, wrong kinds) reject with a
      TypeError BEFORE the engine runs anything,
   4. valid calls pass through unchanged, and the chrome callback
      adapter pops its trailing callback before the validation runs. */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { buildInventory } from "../inventory";
import { ARG_SCHEMAS, argKindOf, installArgValidation, validateArgs } from "../arg-schemas";

const enc = new TextEncoder();

const ALL_NS_PERMISSIONS = [
  "storage", "tabs", "notifications", "contextMenus", "downloads", "cookies",
  "webRequest", "webRequestBlocking", "webNavigation", "alarms", "management",
  "browsingData", "declarativeNetRequest", "bookmarks",
];

async function allPermsApi() {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(
    new Map([
      [
        "manifest.json",
        /* random name: the id derives from the package content, and
           the subsystem IDB persists across managers in one test run */
        enc.encode(JSON.stringify({ manifest_version: 3, action: {}, permissions: ALL_NS_PERMISSIONS, name: "Args" + Math.random().toString(36).slice(2, 7), version: "1.0" })),
      ],
    ]),
  );
  const rec = m.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  return buildApi(
    rec,
    { extensionId: id, context: "background", url: null } as never,
    { messenger: new ExtensionMessenger(), storage, manager: m },
  );
}

/** The mounted member paths of the five covered namespaces (methods
    only; events and constants have no argument contract). Nested area
    members (storage.local.get, ...) count as methods of their own. */
function coveredMethodPaths(browser: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const ns of buildInventory(browser)) {
    if (ns.name !== "alarms" && ns.name !== "cookies" && ns.name !== "runtime" && ns.name !== "tabs" && ns.name !== "storage") continue;
    for (const mem of ns.members) {
      if (mem.kind === "method") {
        out.push(`${ns.name}.${mem.name}`);
        continue;
      }
      /* storage areas mount as plain objects with function members;
         every other non-method member is an event or constant and has
         no argument contract. */
      if (ns.name === "storage" && ["local", "sync", "session"].includes(mem.name)) {
        const area = (browser.storage as Record<string, unknown>)[mem.name] as Record<string, unknown>;
        for (const [k, inner] of Object.entries(area)) {
          if (typeof inner === "function") out.push(`storage.${mem.name}.${k}`);
        }
      }
    }
  }
  return out.sort();
}

describe("argument schemas (#516 slice 3)", () => {
  let api: { browser: Record<string, unknown>; chrome: Record<string, unknown> };
  const fn = (): void => undefined; /* a value no position in the table admits */

  const call = (path: string, ...args: unknown[]): unknown => {
    const parts = path.split(".");
    let obj: Record<string, unknown> = api.browser;
    for (const p of parts.slice(0, -1)) obj = obj[p] as Record<string, unknown>;
    return (obj[parts[parts.length - 1]] as (...a: unknown[]) => unknown)(...args);
  };

  it("argKindOf classifies the table's vocabulary", () => {
    expect(argKindOf(null)).toBe("null");
    expect(argKindOf([1])).toBe("array");
    expect(argKindOf("s")).toBe("string");
    expect(argKindOf(1)).toBe("number");
    expect(argKindOf({})).toBe("object");
    expect(argKindOf(fn)).toBe("function");
    expect(argKindOf(undefined)).toBe("undefined");
  });

  it("validateArgs checks arity first, then per-position kinds", () => {
    const schema: import("../arg-schemas").ArgSchema = { min: 1, max: 2, types: [["string"], null] };
    expect(() => validateArgs("x.y", schema, [])).toThrow(TypeError);
    expect(() => validateArgs("x.y", schema, ["a", "b", "c"])).toThrow(TypeError);
    expect(() => validateArgs("x.y", schema, [fn])).toThrow(/argument 1 must be string/);
    expect(() => validateArgs("x.y", schema, ["a", fn])).not.toThrow(); /* position 2 unchecked (null) */
  });

  it("every schema path resolves to a mounted function on the full surface", async () => {
    api = await allPermsApi();
    const stale: string[] = [];
    for (const path of Object.keys(ARG_SCHEMAS)) {
      const parts = path.split(".");
      let obj: unknown = api.browser;
      for (const p of parts) {
        obj = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[p] : undefined;
      }
      if (typeof obj !== "function") stale.push(path);
    }
    expect(stale, "ARG_SCHEMAS entries that do not resolve to a mounted method").toEqual([]);
  });

  it("every mounted method of the five covered namespaces has a schema", async () => {
    api = await allPermsApi();
    const mounted = coveredMethodPaths(api.browser);
    const tabled = Object.keys(ARG_SCHEMAS).sort();
    const missing = mounted.filter((p) => !tabled.includes(p));
    const extra = tabled.filter((p) => !mounted.includes(p));
    expect(missing, "mounted methods without an argument schema").toEqual([]);
    expect(extra, "ARG_SCHEMAS entries beyond the five covered namespaces' mounted methods").toEqual([]);
  });

  it("too few or too many arguments reject with a TypeError before the engine runs", async () => {
    api = await allPermsApi();
    for (const [path, schema] of Object.entries(ARG_SCHEMAS)) {
      if (schema.min > 0) {
        expect(() => call(path, ...new Array(schema.min - 1).fill(undefined)), `${path} min arity`).toThrow(TypeError);
      }
      if (schema.max < 9) {
        /* arity runs before the kind check, so the filler value never matters */
        expect(() => call(path, ...new Array(schema.max + 1).fill("x")), `${path} max arity`).toThrow(TypeError);
      }
    }
  });

  it("wrong kinds reject with a TypeError naming the position", async () => {
    api = await allPermsApi();
    for (const [path, schema] of Object.entries(ARG_SCHEMAS)) {
      if (!schema.types) continue;
      /* pad to max arity with values that pass their own positions */
      const args: unknown[] = [];
      for (let i = 0; i < schema.max; i++) args.push(sampleOf(schema.types[i] ?? ["any"]));
      for (let i = 0; i < args.length && i < schema.types.length; i++) {
        const allowed = schema.types[i];
        if (!allowed || allowed.includes("any")) continue;
        const wrong: unknown[] = [...args];
        wrong[i] = fn; /* a function no position admits */
        expect(() => call(path, ...wrong), `${path} position ${i + 1}`).toThrow(/must be/);
      }
    }
  });

  it("valid calls pass through to the real implementation", async () => {
    api = await allPermsApi();
    await call("storage.local.set", { a: 1 });
    await expect(call("storage.local.get", "a")).resolves.toEqual({ a: 1 });
    await expect(call("storage.local.get")).resolves.toEqual({ a: 1 }); /* the no-arg whole-store form */
    await expect(call("storage.local.getBytesInUse", ["a"])).resolves.toBeGreaterThan(0);
    await call("alarms.create", "n", { delayInMinutes: 1 });
    await expect(call("alarms.get", "n")).resolves.toHaveProperty("name", "n");
    await call("alarms.create", { delayInMinutes: 1 }); /* the object-first overload: no name means "" */
    await expect(call("alarms.get", "")).resolves.toHaveProperty("name", "");
    expect(call("runtime.getURL", "x")).toContain("x");
    /* getManifest is synchronous on browser.* */
    expect(call("runtime.getManifest")).toHaveProperty("name", expect.stringMatching(/^Args/));
    await expect(call("tabs.query", {})).resolves.toBeTruthy();
    await expect(call("cookies.getAll", {})).resolves.toBeTruthy();
    await expect(call("runtime.getContexts")).resolves.toHaveProperty("length");
    /* installArgValidation is idempotent across contexts: a fresh
       surface from the same areas is wrapped from originals, never
       double-wrapped (double arity errors would say "expected at
       least 1, got 0" twice-deep; a simple call still works). */
    const fresh = await allPermsApi();
    api = fresh;
    await expect(call("storage.local.get", "zz")).resolves.toEqual({ zz: null });
  });

  it("the chrome adapter pops its trailing callback before validation", async () => {
    api = await allPermsApi();
    await new Promise<void>((resolve) => {
      (api.chrome as Record<string, any>).alarms.get("missing", (alarm: unknown) => {
        expect(alarm).toBeUndefined();
        resolve();
      });
    });
    /* chrome arity errors surface as rejections like on browser */
    expect(() => (api.chrome as Record<string, any>).runtime.getURL()).toThrow(TypeError);
  });
});

function sampleOf(kinds: string[]): unknown {
  const kind = kinds.includes("any") ? "object" : kinds[0];
  switch (kind) {
    case "string": return "s";
    case "number": return 1;
    case "boolean": return true;
    case "object": return {};
    case "array": return [];
    case "null": return null;
    case "function": return (): void => undefined;
    default: return {};
  }
}

/* installArgValidation must be a no-op on surfaces without the
   covered namespaces (permission-gated away): nothing throws. */
describe("argument schema installation on gated surfaces", () => {
  it("skips unmounted namespaces silently", async () => {
    const m = new ExtensionManager();
    await m.startup();
    const { id } = await m.installFiles(
      new Map([["manifest.json", enc.encode(JSON.stringify({ manifest_version: 3, name: "bare", version: "1.0" }))]]),
    );
    const rec = m.get(id)!;
    const api = buildApi(
      rec,
      { extensionId: id, context: "background", url: null } as never,
      { messenger: new ExtensionMessenger(), storage: {
          local: new ExtensionStorageArea(id, "local", "local"),
          sync: new ExtensionStorageArea(id, "sync", "sync"),
          session: new ExtensionStorageArea(id, "session", "session"),
        }, manager: m },
    );
    const bare = { runtime: { getURL: (p: string) => "u:" + p } };
    expect(() => installArgValidation(bare)).not.toThrow();
    /* a table path present on an unrelated object wraps transparently,
       behavior unchanged */
    expect((bare.runtime.getURL as (p: string) => string)("k")).toBe("u:k");
    expect(typeof (api.browser as Record<string, unknown>).cookies).toBe("undefined"); /* gated away */
  });
});
