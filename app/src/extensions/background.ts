/* Zeolite extension subsystem: background runtime.

   Executes MV2 / Firefox-style MV3 background scripts. A service
   worker cannot spawn real isolated workers, so each extension's
   scripts run inside one Function scope receiving ONLY the extension
   API object: no access to the engine's real service-worker global,
   and no shared scope with other extensions. Multiple background
   scripts of one extension share that single scope, matching
   Firefox's single background global.

   Lifecycle for script backgrounds: boot success -> RUNNING, boot
   failure -> ERROR with the message recorded on the extension
   (visible to the manager/UI); the engine itself never fails because
   an extension did. onInstalled fires on the extension's first-ever
   boot, onStartup on every later one; the marker persists in
   IndexedDB across SW restarts.

   MV3 service-worker backgrounds (background.service_worker, no
   scripts) are NOT booted eagerly. They follow a service-worker-ish
   lifecycle: stopped until an event arrives, woken on demand by
   wakeExtension() (extension messages, menu clicks), terminated
   after 30s idle via idleTerminate(). Termination drops the
   extension's messenger listeners so the next wake re-executes the
   script; shared-context event listeners (tabs.onUpdated etc.) are
   registered against engine singletons and survive termination -
   that is a documented limitation (see ./compat), faked away
   nowhere. Re-wakes fire no onInstalled/onStartup. An errored
   service-worker background stays down: the engine never
   auto-restarts a crashed worker. */

import { extensions } from "./manager";
import { getExtensionContext, MESSENGER } from "./context";
import { idbGet, idbPut, openDb, STORE_META } from "./idb";
import type { ExtensionId, ExtensionRecord } from "./types";

const BOOT_MARKER = "zl-boot:";
const SW_IDLE_MS = 30_000;

/* #560: a real background page's self IS the global scope: platform
   globals (location, atob, btoa, setTimeout, fetch, crypto, ...)
   read through self like any other window property - Tampermonkey
   5.5.0 destructures location from self at module scope and reads
   .origin on it, which threw at boot on the API-only proxy. The
   API object still shadows (extension API names win), addEventListener
   stays the no-op it always was, and anything else falls through to
   the real worker global: self.location.origin in the SW is the
   engine origin, the exact origin the extension's own pages report
   for sender-origin comparisons. Exported for the sandbox regression
   test; the boot is the only caller. */
export function buildBackgroundDocument(
  loadScript?: (src: string) => Promise<void>,
): Record<string, unknown> {
  /* #560 residual: Tampermonkey 5.5.0 (the Firefox MV2 build) is a
     background PAGE: its scripts read document.createElement (a
     registry module loader that appends script tags and waits for
     onload/onerror), document.head, document.body,
     document.documentElement and document.createTextNode (asap
     setImmediate feature-detects) at boot, so the documentless
     sandbox failed with "ReferenceError: document is not defined".
     Inert elements answer the surface; appendChild of a script
     element carrying a src hands it to loadScript (fetch the
     package resource, evaluate it under the same Function-scope
     contract, then fire the element's onload/onerror). Stub
     elements deliberately lack onreadystatechange: claiming it
     would steer the asap setImmediate polyfill into a DOM branch
     whose events never fire here, hanging every queued task; the
     MessageChannel branch it keeps instead is the worker-correct
     one. */
  const maybeLoad = (el: Record<string, unknown>): void => {
    if (el.tagName !== "SCRIPT" || el.loaded === true) return;
    const src = String(el["attr:src"] ?? el.src ?? "");
    if (!src || !loadScript) return;
    el.loaded = true;
    void loadScript(src).then(
      () => {
        if (typeof el.onload === "function") (el.onload as () => void)();
      },
      () => {
        if (typeof el.onerror === "function") (el.onerror as () => void)();
      },
    );
  };
  const makeNode = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      style: {},
      onload: null,
      onerror: null,
      parentNode: null,
      children: [] as unknown[],
      setAttribute(k: unknown, v: unknown) {
        el["attr:" + String(k)] = String(v);
      },
      getAttribute(k: unknown) {
        const v = el["attr:" + String(k)];
        return v === undefined ? null : v;
      },
      removeAttribute(k: unknown) {
        delete el["attr:" + String(k)];
      },
      appendChild(c: unknown) {
        (el.children as unknown[]).push(c);
        if (c !== null && typeof c === "object") {
          const node = c as Record<string, unknown>;
          node.parentNode = el;
          maybeLoad(node);
        }
        return c;
      },
      removeChild(c: unknown) {
        const kids = el.children as unknown[];
        const i = kids.indexOf(c);
        if (i >= 0) kids.splice(i, 1);
        if (c !== null && typeof c === "object") {
          (c as Record<string, unknown>).parentNode = null;
        }
        return c;
      },
    };
    return el;
  };
  const head = makeNode("head");
  return {
    readyState: "complete",
    currentScript: null,
    head,
    body: makeNode("body"),
    documentElement: makeNode("html"),
    createElement: (tag: unknown) => makeNode(String(tag)),
    createTextNode: (text: unknown) => ({ data: String(text), parentNode: null }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

export function buildBackgroundSelf(
  apiObj: Record<string, unknown>,
  opts?: { document?: Record<string, unknown> },
): object {
  /* #560 extension: a background page's window IS its global: the
     sandbox answers window/self/top/parent reads with itself,
     a document stub when the caller provides one (script/page
     backgrounds only; Chrome MV3 service-worker backgrounds stay
     documentless, Chrome parity), and page writes land in a bag
     the reads see first. Realm identities and location never take
     a page write: a real page cannot rebind them either, and a bag
     shadow would break the platform fall-through that fixed the
     original boot crash. */
  const workerGlobal = globalThis as Record<string, unknown>;
  const bag: Record<string, unknown> = {};
  const self: object = new Proxy(
    {},
    {
      get: (_t, prop) => {
        const name = String(prop);
        if (name === "addEventListener") return () => undefined;
        if (name === "window" || name === "self" || name === "top" || name === "parent") {
          return self;
        }
        if (name === "document") return opts?.document;
        if (Object.prototype.hasOwnProperty.call(bag, name)) return bag[name];
        const v = apiObj[name];
        return v === undefined ? workerGlobal[name] : v;
      },
      set: (_t, prop, value) => {
        const name = String(prop);
        if (
          name !== "location" && name !== "document" && name !== "window" &&
          name !== "self" && name !== "top" && name !== "parent"
        ) {
          bag[name] = value;
        }
        return true;
      },
    },
  ) as unknown as object;
  return self;
}

/** True for MV3 service-worker backgrounds: no scripts, no page, a
    declared service worker. Firefox-style background scripts (MV2 or
    MV3 with background.scripts) are NOT this: they boot eagerly. */
export function backgroundIsServiceWorker(rec: ExtensionRecord): boolean {
  const bg = rec.background;
  return bg !== null && bg.scripts.length === 0 && bg.page === null && bg.serviceWorker !== null;
}

const swRunning = new Set<ExtensionId>();
const idleTimers = new Map<ExtensionId, ReturnType<typeof setTimeout>>();

function armIdleTimer(id: ExtensionId): void {
  const prev = idleTimers.get(id);
  if (prev) clearTimeout(prev);
  idleTimers.set(id, setTimeout(() => idleTerminate(id), SW_IDLE_MS));
}

/** Terminate an idle MV3 service-worker background: drop its
    messenger listeners and mark it not-running. Exported so tests
    can drive the lifecycle deterministically. */
export function idleTerminate(id: ExtensionId): void {
  const t = idleTimers.get(id);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(id);
  }
  if (!swRunning.delete(id)) return;
  MESSENGER.clear(id);
  const rec = extensions.get(id);
  if (rec && rec.state === "running") extensions.setState(id, "installed", null);
}

/** Wake an MV3 service-worker background for an incoming event. No-op
    for script backgrounds (they are always live) and for extensions
    that are disabled or in ERROR (a crashed worker is never
    auto-restarted). */
export async function wakeExtension(id: ExtensionId): Promise<void> {
  const rec = extensions.get(id);
  if (!rec || !rec.enabled || rec.state === "error") return;
  if (!backgroundIsServiceWorker(rec)) return;
  if (swRunning.has(id)) {
    armIdleTimer(id);
    return;
  }
  swRunning.add(id);
  await bootExtension(rec, { swWake: true });
  if (extensions.get(id)?.state === "error") {
    swRunning.delete(id);
    return;
  }
  armIdleTimer(id);
}

/** Boot a just-installed extension's script background. bootEnabled
    runs only at worker activation, so an install into a live worker
    would otherwise leave the background dead until the next worker
    evaluation. Service-worker backgrounds stay demand-booted
    (wakeExtension owns them); disabled or already-booted records are
    left alone. A boot failure lands on the record (ERROR), never on
    the caller: the install itself already succeeded. */
export async function bootInstalled(id: ExtensionId): Promise<void> {
  const rec = extensions.get(id);
  if (!rec || !rec.enabled || rec.state !== "installed") return;
  if (backgroundIsServiceWorker(rec)) return;
  try {
    await bootExtension(rec);
  } catch {
    /* engine-level failure (context/db): the record keeps its state
       and the next activation retries via bootEnabled */
  }
}

export async function bootEnabled(): Promise<void> {
  for (const rec of extensions.list()) {
    if (!rec.enabled) continue;
    const bg = rec.background;
    if (!bg || (bg.scripts.length === 0 && !bg.page)) continue;
    /* MV3 service-worker backgrounds boot on demand instead (see
       wakeExtension); the engine never keeps them warm. */
    if (backgroundIsServiceWorker(rec)) continue;
    try {
      await bootExtension(rec);
    } catch (e) {
      /* Recorded inside bootExtension; a broken extension must not
         stop the others from booting. */
      void e;
    }
  }
}

export async function bootExtension(
  rec: ExtensionRecord,
  opts?: { swWake?: boolean },
): Promise<void> {
  const live = extensions.get(rec.id);
  if (!live || !live.enabled) return;
  const ctx = await getExtensionContext(live);
  const db = await openDb();
  const first = (await idbGet(db, STORE_META, BOOT_MARKER + live.id)) === undefined;

  extensions.setState(live.id, "starting", null);
  try {
    const code: string[] = [];
    const bg = live.background;
    if (bg && bg.serviceWorker && bg.scripts.length === 0 && !bg.page) {
      /* MV3 service-worker background: the declared worker script is
         the whole background. */
      const bytes = await extensions.getResource(live.id, bg.serviceWorker, { fromWeb: false });
      if (!bytes) throw new Error("background service worker missing from package: " + bg.serviceWorker);
      code.push(new TextDecoder().decode(bytes));
    } else if (live.background?.page) {
      /* #505: MV2 background.page. Chrome hosts the page in a real
         DOM document; this engine's background sandbox has no DOM, so
         the page's classic scripts are extracted and executed
         instead, in document order, and background.page takes
         precedence over background.scripts exactly as in Chrome. A
         page script that touches document or window throws at boot
         and fails the background with the error recorded; the
         compatibility matrix states that limit instead of hiding it.
         A page with no scripts is a valid inert background (Chrome
         parity). */
      const pagePath = live.background.page;
      const pageBytes = await extensions.getResource(live.id, pagePath, { fromWeb: false });
      if (!pageBytes) {
        throw new Error("background page missing from package: " + pagePath);
      }
      const page = new TextDecoder().decode(pageBytes);
      const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
      const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      let m: RegExpExecArray | null;
      while ((m = scriptRe.exec(page)) !== null) {
        const attrs = m[1];
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        if (srcMatch) {
          const raw = (srcMatch[1] || srcMatch[2] || "").split("?")[0].split("#")[0];
          if (!raw) continue;
          const target = raw.startsWith("/") ? raw : dir + raw;
          const bytes = await extensions.getResource(live.id, target, { fromWeb: false });
          if (!bytes) throw new Error("background script missing from package: " + raw);
          code.push(new TextDecoder().decode(bytes));
          continue;
        }
        /* Inline scripts: classic only. ES modules cannot resolve
           imports inside the Function sandbox, and data blocks such
           as ld+json are not code. */
        const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
        const type = (typeMatch?.[1] || typeMatch?.[2] || "").toLowerCase();
        if (type && type !== "text/javascript" && type !== "application/javascript") continue;
        if (m[2].trim()) code.push(m[2]);
      }
    } else {
      for (const s of bg?.scripts ?? []) {
        const bytes = await extensions.getResource(live.id, s, { fromWeb: false });
        if (!bytes) throw new Error("background script missing from package: " + s);
        code.push(new TextDecoder().decode(bytes));
      }
    }
    /* Function-scope execution: the scripts see only the API objects.
       self is a proxy over the API surface, NOT the real SW global. */
    const apiObj = ctx.api.browser as Record<string, unknown>;
    /* #560 residual: Firefox-style script and page backgrounds run
       in a DOM page in Firefox; they receive a document stub and a
       window alias as explicit Function-scope params, so bare reads
       in the scripts and in every later callback they define resolve
       against the stub, never against the engine global. The
       stub's script-tag loader fetches package resources and
       evaluates them under the same scope contract. Chrome MV3
       service-worker backgrounds stay documentless (Chrome parity);
       their document/window params are undefined. */
    const isSwBg = backgroundIsServiceWorker(rec);
    const pageDir =
      bg?.page && bg.page.includes("/")
        ? bg.page.slice(0, bg.page.lastIndexOf("/") + 1)
        : "";
    const docStub = isSwBg
      ? undefined
      : buildBackgroundDocument(
          async (src: string): Promise<void> => {
            let path = src.split("?")[0].split("#")[0];
            const scheme = path.indexOf("://");
            if (scheme >= 0) {
              const rest = path.slice(scheme + 3);
              const slash = rest.indexOf("/");
              path = slash >= 0 ? rest.slice(slash) : "/" + rest;
            }
            if (!path.startsWith("/")) path = pageDir + path;
            const bytes = await extensions.getResource(live.id, path, {
              fromWeb: false,
            });
            if (!bytes) {
              throw new Error("background script missing from package: " + src);
            }
            const evalFn = new Function(
              "browser",
              "chrome",
              "self",
              "document",
              "window",
              '"use strict";\n' +
                new TextDecoder().decode(bytes),
            );
            evalFn(
              ctx.api.browser,
              ctx.api.chrome,
              sandboxSelf,
              docStub,
              sandboxSelf,
            );
          },
        );
    const sandboxSelf = isSwBg
      ? buildBackgroundSelf(apiObj)
      : buildBackgroundSelf(apiObj, {
          document: docStub as Record<string, unknown>,
        });
    const fn = new Function(
      "browser",
      "chrome",
      "self",
      "document",
      "window",
      '"use strict";\n' + code.join("\n;\n"),
    );
    /* #139: polyfill-shaped extensions detect globalThis.browser /
       globalThis.chrome at load (verified against
       webextension-polyfill 0.12.0: it requires
       globalThis.chrome.runtime.id, and skips its callback wrapping
       when globalThis.browser.runtime.id exists). The Function-scope
       params alone hide both, so the polyfill throws at load. Expose
       the extension's own API objects on the global during the
       synchronous execution only, then restore: the boot is sync, no
       other extension code can interleave, and async callbacks keep
       the scope params, so nothing leaks past the boot. */
    const g = globalThis as Record<string, unknown>;
    const prevBrowser = g.browser;
    const prevChrome = g.chrome;
    g.browser = ctx.api.browser;
    g.chrome = ctx.api.chrome;
    try {
      fn(ctx.api.browser, ctx.api.chrome, sandboxSelf, docStub, sandboxSelf);
    } finally {
      if (prevBrowser === undefined) delete g.browser;
      else g.browser = prevBrowser;
      if (prevChrome === undefined) delete g.chrome;
      else g.chrome = prevChrome;
    }
    extensions.setState(live.id, "running", null);
  } catch (e) {
    extensions.setState(live.id, "error", "background: " + String(e));
  }

  /* Fire lifecycle events to whichever listeners the scripts just
     registered. Listener errors never fail the boot. MV3 service
     workers fire onInstalled on their first-ever wake only; later
     wakes fire nothing (a service worker restart is not a browser
     startup). */
  const rt = ctx.api.browser.runtime as unknown as {
    onInstalled: { _listeners: Set<(d: unknown) => void> };
    onStartup: { _listeners: Set<() => void> };
  };
  try {
    if (first) {
      for (const l of rt.onInstalled._listeners) l({ reason: "install" });
    } else if (!opts?.swWake) {
      for (const l of rt.onStartup._listeners) l();
    }
  } catch {
    /* one bad listener must not break the rest */
  }
  await idbPut(db, STORE_META, BOOT_MARKER + live.id, Date.now());
}
