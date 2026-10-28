/* Shared service-worker runtime state, extracted from sw.ts (issue #87:
  modularize sw.ts - extract cookies, sessions, and virtual context
  state). One module-level instance per worker evaluation, exactly the
  lifetime these bindings had as sw.ts module lets; the request engine
  and the control plane consume them through the accessors instead of
  manipulating raw bindings.

  What lives here is the SHARED mutable engine state: the per-client
  virtual-context map, the active
  fingerprint profile (+ its per-site profile cache), the degraded
  flag, the persisted route-shape toggles (https upgrade, navHandles),
  the route key, the per-site interception table and the docCookie
  port registry. Domain logic stays in its own module (cookies.ts,
  session.ts, vctx.ts, downloads.ts, fingerprint.ts); this file only
  owns the live bindings + their narrow accessor surface.

  Recording state (zl:recordStart/Stop) is control-plane-local and
  stays with the control plane. */

import type { VirtualContext } from "./vctx";
import { documentCookieRead } from "./cookies";
import {
  engineBindingError,
  fingerprintScript,
  resolveProfile,
  workerFingerprintScript,
  type FingerprintProfile,
} from "./fingerprint";
import { ruleFor, ruleProfile, siteRules } from "./siteconfig";
import { httpsUpgraded } from "./config";
import { currentEngine } from "./transport";

export const ZEOLITE_VERSION = "3.0 Diamond";

/* ---- Per-client virtual contexts (issue #33) ------------------------ */

/* Keyed by FetchEvent clientId. Serving a client's document or worker
   script from a decodable engine route establishes that client's
   context; escaped same-origin paths resolve against it before the
   referrer compat fallback. Memory-only by design: a restarted SW
   starts empty and re-establishes per client (see ./vctx.ts). */
export const VCTX = new Map<string, VirtualContext>();

/* ---- Degraded flag (finding 5, SW half) ----------------------------- */

/* When a core engine component fails to initialize, record it once so
   zl:ping can report the degraded state instead of a bare ok:true
   that hides the failure. Null = fully operational. */
let engineDegraded: string | null = null;

export function getEngineDegraded(): string | null {
  return engineDegraded;
}

export function setEngineDegraded(reason: string): void {
  engineDegraded = reason;
}

/* ---- Route-shape toggles (#53, #63) ---------------------------------- */

/* Issue #55: base64url of the realm-held opaque route key, loaded in
   the SW's routeReady. null = no key (routeReady not settled yet, or
   storage unavailable) = the legacy codec. */
let routeKeyB64: string | null = null;
/* Issue #53: opt-in engine-side HTTPS upgrade. The live toggle
   persists with the route shape; the pure transform is
   config.ts:httpsUpgraded. Applied at the single destination choke
   point and per redirect hop, so the engine never fetches cleartext
   while it is on. No silent downgrade: a failed https fetch fails
   through the normal error pipeline. */
let httpsUpgrade = true;
/* #63: opt-in refusal of the plaintext ?url= initial navigation.
   Hosts adopt zl:navHandle and flip this so the legacy embed can no
   longer appear browser-visible on the deployment. Persists with the
   route shape; resets to false (legacy accepted) on a teardown/full
   storage wipe, which is the documented migration window. */
let navHandles = false;

export function getRouteKey(): string | null {
  return routeKeyB64;
}

export function setRouteKey(key: string | null): void {
  routeKeyB64 = key;
}

export function isHttpsUpgrade(): boolean {
  return httpsUpgrade;
}

export function setHttpsUpgrade(on: boolean): void {
  httpsUpgrade = on;
}

/* ---- HTTPS-only proceed-anyway (LB #76) ---------------------------- */

/* Hosts the user explicitly allowed over cleartext through the
   error page proceed link (zlHttpOk=1). Ephemeral like the toggle:
   resets on SW restart, the host re-sends the toggle and the user
   can re-allow. A session-scoped user decision, never persisted,
   never silent. */
const httpExempt = new Set<string>();

function hostOf(dest: string): string | null {
  try {
    return new URL(dest).hostname || null;
  } catch {
    return null;
  }
}

export function httpExemptAdd(dest: string): void {
  const h = hostOf(dest);
  if (h) httpExempt.add(h);
}

export function httpExemptHas(dest: string): boolean {
  const h = hostOf(dest);
  if (!h) return false;
  for (const site of httpExempt) {
    if (h === site || h.endsWith("." + site)) return true;
  }
  return false;
}

/** The upgrade choke point with the exemptions folded in: on only
    when the toggle is on, the host is not user-exempt, and the host
    is not potentially trustworthy. */
export function destUpgraded(dest: string): string {
  const h = hostOf(dest);
  if (h && isLoopbackHost(h)) return dest;
  return httpsUpgraded(dest, isHttpsUpgrade() && !httpExemptHas(dest));
}

/* Potentially-trustworthy hosts (localhost, loopback) are never
   upgraded, mirroring browser HTTPS-First semantics: an http://
   loopback origin is already trusted, local embedders and the E2E
   harness run plain-http servers on 127.0.0.1, and no upgrade can
   ever succeed there. Not a policy hole: a remote site cannot make
   the engine treat loopback as anything else. */
function isLoopbackHost(h: string): boolean {
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === "::1" ||
    h === "[::1]"
  );
}

export function navHandlesEnabled(): boolean {
  return navHandles;
}

export function setNavHandles(on: boolean): void {
  navHandles = on;
}

/* Injector phase 2: query-shape committed routes (the opaque token
   rides ?zlNavh=, the real path stays the committed pathname).
   Always on by default; a host zl:config can still opt a deployment
   out. Ephemeral like navHandles: resets on SW restart, the host
   re-sends its choice on boot. */
let queryRoutes = true;

export function queryRoutesEnabled(): boolean {
  return queryRoutes;
}

export function setQueryRoutes(on: boolean): void {
  queryRoutes = on;
}

/* #211 (LobsterBrowse): zl:reloadBypass arms a one-shot page-cache
   bypass consumed by the next document GET (the embedder's
   Reload-and-bypass-cache). Ephemeral: resets on SW restart. */
let reloadBypass = false;

export function reloadBypassArmed(): boolean {
  return reloadBypass;
}

export function setReloadBypass(on: boolean): void {
  reloadBypass = on;
}

/* Lazy images (always on, #413): the rewriter injects
   loading="lazy" on <img> tags that lack one, so below-the-fold
   images defer until they approach the viewport. Ephemeral like
   adblock: resets on SW restart, so the module default itself
   carries the intent - a host zl:config stays the runtime
   opt-out. */
let imageLazy = true;

export function isImageLazy(): boolean {
  return imageLazy;
}

export function setImageLazy(on: boolean): void {
  imageLazy = on;
}

/* #487 phase 4: the LEARNED literal-pass demotion is opt-in (default
   off). Evidence recording (#487 phase 3) is observe-only and always
   on; this flag only gates whether corroborated evidence may change
   behavior. Ephemeral like imageLazy: resets on restart, the host
   zl:config is the runtime switch (and the kill switch). */
let adaptiveTransit = false;

export function adaptiveTransitEnabled(): boolean {
  return adaptiveTransit;
}

export function setAdaptiveTransit(on: boolean): void {
  adaptiveTransit = on;
}

/* ---- Per-site route table ------------------------------------------ */

/** Sites the user disabled for this engine. Keyed by registrable-ish
    host suffix (match on hostname or any parent domain). */
const disabledSites = new Set<string>();

export function siteDisabled(target: string): boolean {
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return false;
  }
  for (const site of disabledSites) {
    if (host === site || host.endsWith("." + site)) return true;
  }
  return false;
}

/** zl:siteRoute: enable or disable interception for one site. */
export function setSiteEnabled(site: string, enabled: boolean): void {
  if (!enabled) disabledSites.add(site);
  else disabledSites.delete(site);
}

/* ---- Download registry ----------------------------------------------- */

/* #90: the download registry instance (DL) now lives in ./downloads.ts
   with its domain logic - the downloads subsystem owns its own state.
   initReady loads it, the request engine feeds it through the
   adoptResponse seam, and the control plane lists and cancels entries
   by importing it from ./downloads directly. */

/* ---- Fingerprinting resistance (1.8 Telluride) ----------------------- */

/* The active profile is compiled once into the document init script
   and mirrored onto the upstream wire (User-Agent, Accept-Language).
   Null = fully native surfaces, the honest default. Resets on SW
   restart, like the other host toggles; a rejected profile never
   changes active state. */
let fpProfile: FingerprintProfile | null = null;
let fpScript: string | null = null;
/* 2.3 Selenide: the same profile compiled for worker contexts
   (WorkerNavigator + OffscreenCanvas; documents keep fpScript). */
let fpWorkerScript: string | null = null;

export function getFpProfile(): FingerprintProfile | null {
  return fpProfile;
}

export function getFpScript(): string | null {
  return fpScript;
}

export function getFpWorkerScript(): string | null {
  return fpWorkerScript;
}

export function setFingerprint(profile: unknown): { ok: true; profile?: FingerprintProfile } | { ok: false; error: string } {
  if (profile === null || profile === undefined) {
    fpProfile = null;
    fpScript = null;
    fpWorkerScript = null;
    return { ok: true };
  }
  try {
    const p = resolveProfile(profile);
    /* #71: a profile bound away from the live engine is refused with
       a reason (same refusal pattern as contradictory profiles), not
       silently applied under a different TLS stack. The live engine
       is the one zl:transport reports / switches on next init. */
    const bindErr = engineBindingError(p, currentEngine());
    if (bindErr) return { ok: false, error: bindErr };
    fpProfile = p;
    fpScript = fingerprintScript(p);
    fpWorkerScript = workerFingerprintScript(p);
    return { ok: true, profile: p };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* #80: per-site FingerprintProfiles are siteconfig DATA. Resolved and
   compiled once per host, then cached for the SW lifetime (the rules
   fetch is already memoized). The global zl:fingerprint profile wins
   over site data; invalid or engine-mismatched site data degrades to
   null and never blocks a request. */
type SiteFp = { p: FingerprintProfile; script: string; workerScript: string } | null;
const siteFpCache = new Map<string, { p: FingerprintProfile; script: string; workerScript: string } | null>();
export async function siteProfileFor(target: string): Promise<SiteFp> {
  let host = "";
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (siteFpCache.has(host)) return siteFpCache.get(host) ?? null;
  const p = ruleProfile(ruleFor(await siteRules(), target), currentEngine());
  const entry = p ? { p, script: fingerprintScript(p), workerScript: workerFingerprintScript(p) } : null;
  siteFpCache.set(host, entry);
  return entry;
}

/* ---- docCookie port registry (#35) ----------------------------------- */

/* The page's synchronous document.cookie getter serves an optimistic
   copy refreshed over the zl:docCookie port; a Set-Cookie admitted on
   a proxied fetch/XHR response used to stay invisible until the
   page's next read. The fetch path pushes the fresh jar view over
   the same port right after admission. Keyed by client id, one LIST
   of ports per client (#108: a guarded same-origin child realm
   shares its parent's client id; its registration must not evict the
   parent's port, the push reaches every document of the client);
   capped so a page that keeps re-opening docCookie channels cannot
   grow the map without bound (the oldest client is dropped, its
   ports simply stop receiving pushes - reads still refresh on
   demand). */
const docCookiePorts = new Map<string, Array<{ port: MessagePort; page: string }>>();
const DOC_COOKIE_PORTS_CAP = 128;
/* #253: one noisy page could grow its own port list without bound
   while staying under the distinct-client cap; the per-client cap
   evicts that client oldest port (closed, so the page channel
   reports dead instead of silently going quiet). 16 covers every
   real multi-document shape. */
/* ponytail: raise only with a real page that legitimately holds more
   live docCookie channels for one client. */
const DOC_COOKIE_PORTS_PER_CLIENT = 16;

export function pushDocCookieView(clientId: string): void {
  const list = clientId ? docCookiePorts.get(clientId) : undefined;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i].port.postMessage({ ok: true, cookie: documentCookieRead(list[i].page, clientId) });
    } catch {
      /* port closed: that document is gone; drop its entry, the
         client's other documents keep receiving pushes */
      list.splice(i, 1);
    }
  }
  if (!list.length) docCookiePorts.delete(clientId);
}

/** zl:docCookie: keep the port so the fetch path can push jar updates
    (Set-Cookie on a proxied response) into this client's optimistic
    document.cookie copy. Cap-aware: past the limit the oldest client
    is dropped first. #108: a guarded child realm registers a second
    port under the SAME client id; the registry appends, never
    replaces. */
export function registerDocCookiePort(clientId: string, port: MessagePort, page: string): void {
  let list = docCookiePorts.get(clientId);
  if (!list) {
    if (docCookiePorts.size >= DOC_COOKIE_PORTS_CAP) {
      const oldest = docCookiePorts.keys().next();
      if (!oldest.done && oldest.value !== undefined) docCookiePorts.delete(oldest.value);
    }
    list = [];
    docCookiePorts.set(clientId, list);
  }
  /* #253: per-client cap; the eviction is this client oldest
     registration, not another client. */
  if (list.length >= DOC_COOKIE_PORTS_PER_CLIENT) {
    const evicted = list.shift();
    if (evicted) {
      try {
        evicted.port.close();
      } catch {
        /* already closed */
      }
    }
  }
  list.push({ port, page });
}
