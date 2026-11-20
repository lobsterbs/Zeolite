/* #516 slices 3 + 5: the argument-schema contract (arg-schemas.ts)
   held against the real mounted surface.

   Invariants:
   1. every ARG_SCHEMAS path resolves to a mounted function on the
      all-permissions surface (no stale entries, no silently skipped
      paths that should mount),
   2. every mounted method of the covered namespaces has a schema - a
      new method without one fails here,
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
  "browsingData", "declarativeNetRequest", "declarativeNetRequestFeedback",
  "bookmarks",
];

/* #516 slice 5: the namespaces the argument contract covers.
   browserAction and pageAction mount on MV2 manifests only and
   chrome.extension on MV2 records only, so their coverage is held on
   the MV2 fixtures below; webNavigation and webRequest mount events
   but no methods. */
const COVERED_NAMESPACES = new Set([
  "alarms", "action", "bookmarks", "browserAction", "browsingData",
  "contextMenus", "menus", "cookies", "declarativeNetRequest", "downloads",
  "extension", "i18n", "management", "notifications", "pageAction",
  "permissions", "runtime", "scripting", "storage", "tabs", "windows",
]);

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

/* The MV2 fixtures: the action-family aliases and chrome.extension
   mount for MV2 records only, one action kind per manifest (Firefox
   refuses both keys in one manifest). */
async function mv2Api(actionKey: "browser_action" | "page_action") {
  const m = new ExtensionManager();
  await m.startup();
  const { id } = await m.installFiles(
    new Map([
      [
        "manifest.json",
        enc.encode(JSON.stringify({
          manifest_version: 2,
          [actionKey]: {},
          name: "MV2" + Math.random().toString(36).slice(2, 7),
          version: "1.0",
        })),
      ],
    ]),
  );
  const rec = m.get(id)!;
  return buildApi(
    rec,
    { extensionId: id, context: "background", url: null } as never,
    {
      messenger: new ExtensionMessenger(),
      storage: {
        local: new ExtensionStorageArea(id, "local", "local"),
        sync: new ExtensionStorageArea(id, "sync", "sync"),
        session: new ExtensionStorageArea(id, "session", "session"),
      },
      manager: m,
    },
  );
}

/** The mounted member paths of the covered namespaces (methods
    only; events and constants have no argument contract). Nested area
    members (storage.local.get, ...) count as methods of their own. */
function coveredMethodPaths(browser: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const ns of buildInventory(browser)) {
    if (!COVERED_NAMESPACES.has(ns.name)) continue;
    for (const mem of ns.members) {
      if (mem.kind === "method") {
        out.push(`${ns.name}.${mem.name}`);
        continue;
      }
      /* storage areas mount as plain objects with function members;
         every other non-method member is an event or constant and has
         no argument contract. Managed is the read-only policy area
         whose writes reject at the call itself. */
      if (ns.name === "storage" && ["local", "sync", "session", "managed"].includes(mem.name)) {
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

  it("every schema path resolves to a mounted function on some surface", async () => {
    /* The action-family aliases and chrome.extension mount on MV2
       records only, so a path is stale only when it resolves on NO
       fixture (MV3 all-perms, both MV2 action kinds). */
    const surfaces = [await allPermsApi(), await mv2Api("browser_action"), await mv2Api("page_action")];
    const stale: string[] = [];
    for (const path of Object.keys(ARG_SCHEMAS)) {
      const parts = path.split(".");
      const mounted = surfaces.some((api) => {
        let obj: unknown = api.browser;
        for (const p of parts) {
          obj = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[p] : undefined;
        }
        return typeof obj === "function";
      });
      if (!mounted) stale.push(path);
    }
    expect(stale, "ARG_SCHEMAS entries that do not resolve to a mounted method").toEqual([]);
  });

  it("every mounted method of the covered namespaces has a schema", async () => {
    const surfaces = [await allPermsApi(), await mv2Api("browser_action"), await mv2Api("page_action")];
    const mounted = [...new Set(surfaces.flatMap((api) => coveredMethodPaths(api.browser)))].sort();
    const tabled = Object.keys(ARG_SCHEMAS).sort();
    const missing = mounted.filter((p) => !tabled.includes(p));
    const extra = tabled.filter((p) => !mounted.includes(p));
    expect(missing, "mounted methods without an argument schema").toEqual([]);
    expect(extra, "ARG_SCHEMAS entries beyond the covered namespaces' mounted methods").toEqual([]);
  });

  it("too few or too many arguments reject with a TypeError before the engine runs", async () => {
    const surfaces = [await allPermsApi(), await mv2Api("browser_action"), await mv2Api("page_action")];
    for (const [path, schema] of Object.entries(ARG_SCHEMAS)) {
      const parts = path.split(".");
      const api = surfaces.find((s) => {
        let obj: unknown = s.browser;
        for (const p of parts) {
          obj = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[p] : undefined;
        }
        return typeof obj === "function";
      });
      if (!api) continue;
      const method = resolveFn(api.browser, path);
      if (schema.min > 0) {
        expect(() => method(...new Array(schema.min - 1).fill(undefined)), `${path} min arity`).toThrow(TypeError);
      }
      if (schema.max < 9) {
        /* arity runs before the kind check, so the filler value never matters */
        expect(() => method(...new Array(schema.max + 1).fill("x")), `${path} max arity`).toThrow(TypeError);
      }
    }
  });

  it("wrong kinds reject with a TypeError naming the position", async () => {
    const surfaces = [await allPermsApi(), await mv2Api("browser_action"), await mv2Api("page_action")];
    for (const [path, schema] of Object.entries(ARG_SCHEMAS)) {
      if (!schema.types) continue;
      const parts = path.split(".");
      const api = surfaces.find((s) => {
        let obj: unknown = s.browser;
        for (const p of parts) {
          obj = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[p] : undefined;
        }
        return typeof obj === "function";
      });
      if (!api) continue;
      const method = resolveFn(api.browser, path);
      /* pad to max arity with values that pass their own positions */
      const args: unknown[] = [];
      for (let i = 0; i < schema.max; i++) args.push(sampleOf(schema.types[i] ?? ["any"]));
      for (let i = 0; i < args.length && i < schema.types.length; i++) {
        const allowed = schema.types[i];
        if (!allowed || allowed.includes("any")) continue;
        const wrong: unknown[] = [...args];
        wrong[i] = fn; /* a function no position admits */
        expect(() => method(...wrong), `${path} position ${i + 1}`).toThrow(/must be/);
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
    /* MV2 surfaces: the action-family aliases and chrome.extension
       carry the same contract the table pins (browserAction mirrors
       action; pageAction has no badge surface; extension shares the
       runtime.getURL implementation). */
    const ba = await mv2Api("browser_action");
    await resolveFn(ba.browser, "browserAction.setTitle")({ title: "T" });
    await expect(resolveFn(ba.browser, "browserAction.getTitle")()).resolves.toBe("T");
    await expect(resolveFn(ba.browser, "browserAction.setBadgeText")({ text: "b" })).resolves.toBeUndefined();
    await expect(resolveFn(ba.browser, "browserAction.getBadgeText")()).resolves.toBe("b");
    expect(() => resolveFn(ba.browser, "browserAction.enable")("x")).toThrow(TypeError);
    const pa = await mv2Api("page_action");
    await expect(resolveFn(pa.browser, "pageAction.show")(1)).resolves.toBeUndefined();
    /* pageAction visibility is per-tab: show(tabId) makes THAT tab
       shown while the global default state stays hidden. */
    await expect(resolveFn(pa.browser, "pageAction.isShown")({ tabId: 1 })).resolves.toBe(true);
    await expect(resolveFn(pa.browser, "pageAction.isShown")()).resolves.toBe(false);
    expect(() => resolveFn(pa.browser, "pageAction.show")()).toThrow(TypeError);
    expect(() => resolveFn(pa.browser, "pageAction.setBadgeText")({ text: "b" })).toThrow(TypeError); /* unmounted member */
    const mv2 = await mv2Api("browser_action");
    expect(resolveFn(mv2.browser, "extension.getURL")("x")).toContain("x");
    /* getViews and getBackgroundPage are synchronous engine methods */
    expect(resolveFn(mv2.browser, "extension.getViews")({ windowId: 1 })).toEqual([]);
    expect(resolveFn(mv2.browser, "extension.getBackgroundPage")()).toBeNull();
    /* inIncognitoContext is a constant on the MV2 surface, not a method - no argument contract */
    expect((mv2.browser as Record<string, unknown>).extension).toHaveProperty("inIncognitoContext", false);
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

  /* ---- 2026-11-20: the Tampermonkey white-options-page fix ------ */

  it("explicit trailing undefined arguments resolve to omitted, not arity errors", async () => {
    /* TM's MV2 SDK wrapper forwards the optional callback slot it
       never received: setIcon(details, undefined) has
       arguments.length 2 but is a one-argument call. The pre-fix
       validator rejected that on arity (browserAction.setIcon:
       "expected at most 1 argument(s), got 2"), TM's init promise
       Dp rejected, every runtime.onMessage stayed queued behind
       registerLateCallback, and the options page never answered its
       ping: white page. */
    api = await allPermsApi();
    const ba = await mv2Api("browser_action");
    await expect(resolveFn(ba.browser, "browserAction.setBadgeText")({ text: "z" }, undefined)).resolves.toBeUndefined();
    await expect(resolveFn(ba.browser, "browserAction.getBadgeText")()).resolves.toBe("z");
    await expect(call("alarms.get", "n", undefined)).resolves.toBeUndefined();
    /* the trim stops at min: too few real arguments stay arity errors */
    expect(() => call("bookmarks.move", undefined)).toThrow(TypeError);
    /* trailing undefined never launders real extra arguments */
    expect(() => resolveFn(ba.browser, "browserAction.setTitle")({ title: "x" }, "y", undefined)).toThrow(TypeError);
  });

  it("one trailing function beyond max is the optional response callback (both surfaces)", async () => {
    api = await allPermsApi();
    await call("storage.local.set", { cbk: 7 });
    let fromCb: unknown = "unset";
    await new Promise<void>((done) => {
      const p = call("storage.local.get", "cbk", (v: unknown) => {
        fromCb = v;
        done();
      }) as Promise<unknown>;
      /* the promise return stays intact; the callback consumes nothing */
      void p.then((v) => expect(v).toEqual({ cbk: 7 }));
    });
    expect(fromCb).toEqual({ cbk: 7 });
    /* a synchronous implementation wires its callback asynchronously too */
    let fromSync: unknown = "unset";
    await new Promise<void>((done) => {
      expect(call("runtime.getURL", "x", (u: unknown) => {
        fromSync = u;
        done();
      })).toContain("x");
    });
    expect(String(fromSync)).toContain("x");
    /* exactly ONE callback slot: two trailing functions still reject */
    expect(() => call("alarms.get", "n", (): void => undefined, (): void => undefined)).toThrow(TypeError);
    /* the chrome surface keeps its own promisified CALLBACK_METHODS
       wiring: no double-fire through the validator's slot */
    await new Promise<void>((done) => {
      (api.chrome as Record<string, any>).alarms.get("missing", (alarm: unknown) => {
        expect(alarm).toBeUndefined();
        done();
      });
    });
  });

  it("a trailing response callback on a rejecting call fires with no arguments and the promise stays rejected", async () => {
    api = await allPermsApi();
    let fired = 0;
    let cbArgs: unknown[] = ["sentinel"];
    const result = call("cookies.set", undefined, (...a: unknown[]) => {
      fired++;
      cbArgs = a;
    }) as Promise<unknown>;
    await expect(result).rejects.toThrow();
    /* the rejection precedes the callback microtask; a macrotask
       await waits it out deterministically */
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fired).toBe(1);
    expect(cbArgs).toEqual([]);
  });

  it("runtime.onUpdateAvailable mounts inert so TM-class init never breaks on it", async () => {
    /* TM's init registers the update event; an undefined member here
       aborted the whole bootstrap in the #573 failure class. Firefox
       declares the event (added 51), so the gap doc drops it. */
    api = await allPermsApi();
    type Ev = {
      addListener(l: (details: unknown) => void): void;
      removeListener(l: (details: unknown) => void): void;
      hasListener(l: (details: unknown) => void): boolean;
    };
    const ev = (api.browser as Record<string, Record<string, unknown>>).runtime.onUpdateAvailable as Ev;
    expect(ev).toBeTruthy();
    const l = (details: unknown): void => void details;
    expect(() => ev.addListener(l)).not.toThrow();
    expect(ev.hasListener(l)).toBe(true);
    expect(() => ev.removeListener(l)).not.toThrow();
    expect(typeof ((api.chrome as Record<string, Record<string, unknown>>).runtime.onUpdateAvailable as Ev).addListener).toBe("function");
  });
});

/** Resolve a dotted method path on one surface (the sweeps and the
    MV2 rows need a surface picker instead of the module-level api). */
function resolveFn(browser: Record<string, unknown>, path: string): (...a: unknown[]) => unknown {
  let obj: unknown = browser;
  for (const p of path.split(".")) {
    obj = obj && typeof obj === "object" ? (obj as Record<string, unknown>)[p] : undefined;
  }
  return obj as (...a: unknown[]) => unknown;
}

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
