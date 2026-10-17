/* Service-worker lifecycle and client isolation (#243-#247).

   The dispatch seams in sw.ts once broadcast tab, scripting, download
   and notification operations to every window client, and proxied
   pages are window clients too: a proxied document could observe
   host operations and other pages' script payloads. The boundary here
   is structural - a client's own URL identifies it, and a page
   cannot fake its client URL:

   - host-only ops (zl:tabsOp, zl:downloadOp, zl:notifyOp) reach only
     clients whose pathname is neither a NAVH route nor an engine
     route (isHostClient; a URL that fails to parse fails closed);
   - page-targeted payloads (zl:tabMessage, zl:scripting) reach only
     the client whose decoded destination matches the target, so an
     unmatched scripting payload is dropped, not broadcast.

   #244: install keeps skipWaiting but now holds the async rewriter
   prewarm in waitUntil (a floating promise gave the worker no
   lifetime guarantee for the slowest cold-path step). A prewarm
   rejection settles to undefined: the loader reports degradation
   through setDegraded, install itself never fails on it.

   #245: the extension boot phases get independent failure
   boundaries: a failed registry restore no longer silently skips
   enabled-extension boot, alarm wake wiring and management wiring;
   each failure lands in DIAG instead of an empty catch. */

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { DIAG } from "./diag";
import { decodeClientUrl, isEnginePath, NAVH } from "./codec";
import type { DownloadOp } from "./extensions/downloads";
import type { NotifyOp } from "./extensions/notifications";
import type { ScriptingMessage } from "./extensions/scripting";
import type { TabMessage, TabsOp } from "./extensions/tabs";

/** The slice of a window Client the dispatch seam needs; tests stub
    this, a real Client satisfies it. */
export interface WinClient {
  url: string;
  postMessage(msg: unknown): void;
}

/** Every window client of this worker. */
export async function windowClients(): Promise<WinClient[]> {
  return (await self.clients.matchAll({ type: "window" })) as unknown as WinClient[];
}

/** #243: a host client is a window on neither a NAVH route nor an
    engine route. Proxied pages live on those routes; anything that
    fails to parse is treated as untrusted. */
export function isHostClient(c: WinClient): boolean {
  try {
    const u = new URL(c.url, self.location.origin);
    if (u.pathname.startsWith(NAVH + "/")) return false;
    return !isEnginePath(u.pathname);
  } catch {
    return false;
  }
}

/** Decode a client's engine path to its destination (dest + search).
    Null when the URL is not decodable (host page, bad URL). */
export function clientDest(c: WinClient): string | null {
  try {
    return decodeClientUrl(new URL(c.url, self.location.origin));
  } catch {
    return null;
  }
}

/** #244: install lifetime. skipWaiting stays; the async prewarm is
    held by waitUntil and settles to undefined on rejection (the
    loader emits the degradation diagnostic itself). */
export function installLifecycle(e: ExtendableEvent, prewarm: () => Promise<void>): void {
  void self.skipWaiting();
  e.waitUntil(
    prewarm().then(
      () => undefined,
      () => undefined,
    ),
  );
}

/** The four independent extension boot phases (#245). */
export interface BootPhases {
  startup(): Promise<void> | void;
  boot(): Promise<void> | void;
  wireAlarm(): void;
  wireMgmt(): void;
}

/** #245: run each boot phase in its own failure boundary; a failure
    emits an EXTENSION diagnostic and never silently skips the
    phases after it. */
export async function bootExtensionSubsystem(p: BootPhases): Promise<void> {
  const phase = (fail: string, run: () => Promise<void> | void): Promise<void> =>
    Promise.resolve()
      .then(run)
      .catch((err: unknown) => {
        DIAG.emit({
          category: "EXTENSION",
          severity: "error",
          message: fail + " (" + String(err) + ")",
        });
      });
  await phase("extension registry restore failed; subsystem degraded", p.startup);
  await phase("enabled-extension boot failed", p.boot);
  await phase("alarm wake wiring failed", p.wireAlarm);
  await phase("management wiring failed", p.wireMgmt);
}

/** The registries whose dispatch seams get wired (#243). */
export interface DispatchHosts {
  tabs: {
    setDispatch(fn: ((op: TabsOp) => void) | null): void;
    setMessageDispatch(
      fn: ((tabId: number, tabUrl: string, extId: string, payload: TabMessage) => void) | null,
    ): void;
  };
  scripting: { setDispatch(fn: ((msg: ScriptingMessage) => void) | null): void };
  downloads: { setDispatch(fn: ((op: DownloadOp) => void) | null): void };
  notify: { setDispatch(fn: ((op: NotifyOp) => void) | null): void };
}

/** #243: wire the five dispatch seams with host-only and
    page-targeted delivery (see the module comment). getClients is
    injectable so tests can drive deterministic clients. */
export function wireDispatchers(
  hosts: DispatchHosts,
  getClients: () => Promise<WinClient[]> = windowClients,
): void {
  const each = (deliver: (c: WinClient) => void): void => {
    void getClients().then((cs) => {
      for (const c of cs) deliver(c);
    });
  };
  hosts.tabs.setDispatch((op) =>
    each((c) => {
      if (isHostClient(c)) c.postMessage({ type: "zl:tabsOp", op });
    }),
  );
  hosts.tabs.setMessageDispatch((_tabId, tabUrl, extId, payload) =>
    each((c) => {
      if (clientDest(c) === tabUrl) {
        c.postMessage({ type: "zl:tabMessage", extId, dest: tabUrl, payload });
      }
    }),
  );
  hosts.scripting.setDispatch((msg) =>
    each((c) => {
      if (clientDest(c) === msg.dest) c.postMessage(msg);
    }),
  );
  hosts.downloads.setDispatch((op) =>
    each((c) => {
      if (isHostClient(c)) c.postMessage({ type: "zl:downloadOp", op });
    }),
  );
  hosts.notify.setDispatch((op) =>
    each((c) => {
      if (isHostClient(c)) c.postMessage({ type: "zl:notifyOp", op });
    }),
  );
}
