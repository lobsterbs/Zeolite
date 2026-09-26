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
    } else {
      for (const s of bg?.scripts ?? []) {
        const bytes = await extensions.getResource(live.id, s, { fromWeb: false });
        if (!bytes) throw new Error("background script missing from package: " + s);
        code.push(new TextDecoder().decode(bytes));
      }
      if (code.length === 0 && live.background?.page) {
        throw new Error(
          "background.page is not supported yet (Firefox-style background scripts are)",
        );
      }
    }
    /* Function-scope execution: the scripts see only the API objects.
       self is a proxy over the API surface, NOT the real SW global. */
    const apiObj = ctx.api.browser as Record<string, unknown>;
    const sandboxSelf = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "addEventListener"
            ? () => undefined
            : apiObj[String(prop)],
      },
    ) as unknown as object;
    const fn = new Function(
      "browser",
      "chrome",
      "self",
      '"use strict";\n' + code.join("\n;\n"),
    );
    fn(ctx.api.browser, ctx.api.chrome, sandboxSelf);
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
