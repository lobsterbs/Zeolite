/// <reference lib="webworker" />
/* Engine-update alerting (#121). Zeolite ships as one service worker
   artifact: a deployment publishes a new sw.js and the embedding
   host bumps its pin, but long-lived tabs never re-run the
   browser's navigation-time update check, so they keep serving the
   old engine until they reload. Two seams close that gap:

   - the ACTIVE worker polls registration.update() - the browser's
     own byte-compare oracle, not a hand-rolled hash poll. A new
     dist installs (the worker already skipWaiting()s on install)
     and takes over via clients.claim().
   - the NEW worker, once active, broadcasts zl:engineUpdate to
     every window client: engine-served pages (the proxied-page
     bootstrap listens) reload once per engine sha, and the
     embedding host's own window - same origin, in scope - sees the
     same message and can surface the alert.

   Detection and replacement only: nothing about running pages is
   patched in place. */

/* The worker context this module runs in (same declaration the
   engine and control plane use; the DOM lib also declares self). */
declare const self: ServiceWorkerGlobalScope;

import { DIAG } from "./diag";
import { ZEOLITE_VERSION } from "./swstate";

/* 5 minutes: a host pin bump plus deploy takes minutes anyway, and
   every worker wake re-runs the module (and one check) fresh.
   ponytail: fixed const, not configurable; a deployment wanting a
   different cadence edits one number. */
const CHECK_MS = 5 * 60 * 1000;

/** sha256 of the worker's own script, first 16 hex chars - the same
    shape the host's /build zlswSha pin reports. null when the script
    cannot be fetched or hashed; never guessed. */
export async function engineSha(): Promise<string | null> {
  const active = self.registration.active;
  const scriptUrl =
    active && active.scriptURL ? active.scriptURL : self.location.origin + "/sw.js";
  const res = await fetch(scriptUrl, { cache: "no-store" });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Announce the active engine to every window client. Best-effort by
    design: a dropped message costs one update cycle, and the
    client-side reload guard is keyed by sha so replays are inert. */
export async function broadcastEngineUpdate(): Promise<void> {
  let sha: string | null = null;
  try {
    sha = await engineSha();
  } catch {
    /* honest: the broadcast still identifies the version */
  }
  const cs = await self.clients.matchAll({ type: "window" });
  for (const c of cs) {
    c.postMessage({ type: "zl:engineUpdate", sha, version: ZEOLITE_VERSION });
  }
}

/** Poll the browser's own update oracle: one check per worker
    evaluation (a worker that wakes after an idle kill re-runs this),
    then every CHECK_MS while the worker stays alive. */
export function startUpdateChecks(): void {
  try {
    self.registration.addEventListener("updatefound", () => {
      DIAG.emit({
        category: "SERVICE_WORKER",
        severity: "info",
        message: "new engine version found; installing (pages reload once it activates)",
      });
    });
  } catch {
    /* no registration object: nothing to poll */
  }
  const check = (): void => {
    void self.registration.update().catch(() => {});
  };
  check();
  setInterval(check, CHECK_MS);
}
