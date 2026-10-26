/* Per-origin cookie jars + virtual-origin registry (Phase 4, 1.4).

   One cookie store partitioned by the virtual-origin registry:
   each target origin gets a collision-free internal id from
   its canonical origin. Cookies attach to a
   request only when their own Domain/Path/Secure attributes say
   so (RFC 6265 matching): never admitted or attached outside
   their domain scope, so unrelated origins are isolated by
   construction. Honesty notes (docs/cookies.md):
   - 2.2: the SW follows 3xx hops itself, applying Set-Cookie at
     every hop; unfollowable hops (307/308 one-shot body) are
     surfaced with a mapped Location, cookies captured first.
   - SameSite enforced only via the opt-in knob (off by default):
     every proxied request is engine-initiated, so the site
     context is approximated from the referrer. SameSite=None
     without Secure is always rejected.
   - document.cookie is virtualized by the bootstrap
     (zl:docCookie); this jar stays authoritative for
     engine-initiated requests, even though the transport
     (libcurl) may also hold cookies internally.
   Persistence: IndexedDB (no localStorage in a SW), one record,
   debounced rewrites. Jar profiles (zl:jarProfile) switch to a
   throwaway in-memory session jar (incognito). */

import { decodeNavHandleRoot, encodeDest } from "./codec";
import { DIAG } from "./diag";
import { traceDecision } from "./tracing";
import { openDb, idbGet, idbPut, STORE_COOKIES } from "./extensions/idb";

import { getDomain, getPublicSuffix } from "tldts";

export type SameSite = "strict" | "lax" | "none";

/* 2.2 Arsenide: opt-in SameSite enforcement. "off" (default) keeps the
   1.4 behavior. "approx" enforces the attribute with a site context the
   caller supplies: the SW passes the decoded referrer (the page that
   initiated the request) and whether the request is a top-level
   navigation. Requests without a decodable initiator are treated as
   same-site; that is the honest limit of an engine-initiated fetch. */
export type SameSitePolicy = "off" | "approx";

/* Session import merge rules for jarMerge (2.2 Arsenide). */
export type JarConflictRule = "import-wins" | "keep-existing" | "keep-newest";

/** Initiator context for cookie attachment (SameSite approximation). */
export interface CookieRequestContext {
  /** Decoded initiator URL (the page that caused this request), when known. */
  initiator?: string;
  /** True for top-level navigations (sec-fetch-dest: document). */
  navigation?: boolean;
  /** #267: SW client id of the requester; scopes the jar profile. */
  clientId?: string;
}

let sameSitePolicy: SameSitePolicy = "off";

/** Set the SameSite policy knob. Unknown values fall back to "off";
    the effective policy is returned so the caller can report it. */
export function setSameSitePolicy(p: unknown): SameSitePolicy {
  sameSitePolicy = p === "approx" ? "approx" : "off";
  return sameSitePolicy;
}

export function sameSitePolicyState(): SameSitePolicy {
  return sameSitePolicy;
}

export interface Cookie {
  name: string;
  value: string;
  /** Cookie Domain as stored (leading dot stripped, lowercase). */
  domain: string;
  /** True when no Domain attribute was present (exact-host scope). */
  hostOnly: boolean;
  /** RFC 6265 default-path applied at admission. */
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite | null;
  /** Expiry in epoch ms; 0 = session cookie. */
  expires: number;
  /** Admission time; RFC 6265 ordering tie-break. */
  created: number;
}

export interface VirtualOrigin {
  origin: string;
  /** Collision-free canonical-origin id, independent of page storage tokens. */
  id: string;
  /** Zeolite-internal representation: engine path base of the origin. */
  pathBase: string;
}

/** One admission decision, for tests and diagnostics. */
export interface SetCookieResult {
  name: string;
  stored: boolean;
  deleted: boolean;
  rejected?: string;
}

/* ---- virtual-origin registry --------------------------------------- */

const registry = new Map<string, VirtualOrigin>();

/* id -> origin reverse map (#41): the registry maps origin -> id, so
   after a SW restart only this map (persisted as the "origins" record)
   can tell jarEnumeration whose cookies a jar key holds. */
const originById = new Map<string, string>();

/* #270: the FNV-1a site hash lives once in bootstrap/siteid.ts; the
   old local copy used double-precision multiplication and collided
   for distinct origins (same bug the page-side token had). */

/** Register (memoized) a target origin and its internal representation. */
function originJarId(origin: string): string {
  return "o" + Array.from(new TextEncoder().encode(new URL(origin).origin), b => b.toString(16).padStart(2, "0")).join("");
}

export function registerOrigin(origin: string): VirtualOrigin {
  origin = new URL(origin).origin;
  let e = registry.get(origin);
  if (!e) {
    e = { origin, id: originJarId(origin), pathBase: encodeDest(origin) };
    registry.set(origin, e);
    originById.set(e.id, origin);
  }
  return e;
}

/* ---- jar ------------------------------------------------------------- */

/** jar key = virtual-origin id of the origin the cookie was SET from. */
const jars = new Map<string, Cookie[]>();

/* ---- jar profiles (host app, zl:jarProfile) --------------------------
   One engine origin serves one host app instance; the host can switch
   the whole jar between the durable "default" profile and a throwaway
   session profile (incognito). Session-profile cookies are in-memory
   only (never persisted to IndexedDB) and are dropped the moment the
   host switches away. Same semantics as the server engine's per-sid
   jar with lb_inc. */

const PROFILE_DEFAULT = "default";
/* A frame recovered from an authenticated handle may beat its host
   window's profile re-push after a worker restart. Keep that request
   cookie-free until the host re-establishes its profile. */
const PROFILE_UNBOUND = "\u0000unbound";
const SEP = "\u0000";
let profile = PROFILE_DEFAULT;

/* #267/#361: profile selection starts at the host app client, while
   proxied requests arrive under iframe client ids. Keep an in-memory
   root association for every controlled child and scope temporary jar
   keys by both root id and profile label. */
const clientRoots = new Map<string, string>();
const rootProfiles = new Map<string, string>();
const unboundClients = new Set<string>();

function rootOf(clientId?: string): string | null {
  if (!clientId) return null;
  return clientRoots.get(clientId) ?? (rootProfiles.has(clientId) ? clientId : null);
}

function activeProfile(clientId?: string): string {
  const root = rootOf(clientId);
  if (root) {
    /* #366 regression: a bound root with no profile entry is the
       NORMAL state in a default deployment (the host never pushes
       zl:jarProfile), so it rides the default jar there. The
       PROFILE_UNBOUND fallback stays for a session deployment, where
       a root that lost its profile (worker restart) fails closed. */
    return rootProfiles.get(root) ?? (profileRestoreFailed || anySessionProfileActive() ? PROFILE_UNBOUND : PROFILE_DEFAULT);
  }
  if (clientId && unboundClients.has(clientId)) return PROFILE_UNBOUND;
  if (profileRestoreFailed && !globalProfileAssigned) return PROFILE_UNBOUND;
  return profile;
}

function namespaceForProfile(pid: string, root: string | null): string {
  if (pid === PROFILE_DEFAULT) return PROFILE_DEFAULT;
  return root ? `client:${encodeURIComponent(root)}:${encodeURIComponent(pid)}` : `legacy:${encodeURIComponent(pid)}`;
}

function namespaceForClient(clientId?: string): string {
  return namespaceForProfile(activeProfile(clientId), rootOf(clientId));
}

/* #366: the shared unbound namespace (no root, no authenticated
   profile) is never a legitimate cookie home: requests from unbound
   clients stay cookie-free and their responses admit nothing, so
   unrelated unbound clients cannot observe each other's cookies and
   nothing unreachable is persisted. */
const UNBOUND_GLOBAL_NAMESPACE = namespaceForProfile(PROFILE_UNBOUND, null);

/** #366: true when any session (non-default) jar profile is active
    anywhere (global or on a bound host root): unattributable worker
    clients fail closed instead of reading or writing the shared
    default jar. */
export function anySessionProfileActive(): boolean {
  if (profile !== PROFILE_DEFAULT) return true;
  for (const pid of rootProfiles.values()) if (pid !== PROFILE_DEFAULT) return true;
  return false;
}

/* #394: the profile map is worker memory that an idle restart wipes;
   a session-profile page would then ride the DURABLE default jar
   (reads from it, Set-Cookie persists into it). Persist the profile
   state in the Cache API (#390 transport-persistence precedent) and
   restore it before the first proxied request is served: a restored
   root has an empty in-memory session jar, so its requests fail
   closed (cookie-free) until the host re-pushes, which is the
   documented restart semantics. */
const PROFILE_CACHE = "zeolite-jar-profile-v1";
let jarProfilesPromise: Promise<void> | null = null;
let profilePersistChain: Promise<void> = Promise.resolve();
let profileRestoreFailed = false;
let globalProfileAssigned = false;
const assignedRoots = new Set<string>();

function validProfileName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !value.includes(SEP);
}

export function jarProfilesReady(): Promise<void> {
  if (!jarProfilesPromise) {
    jarProfilesPromise = (async () => {
      if (typeof caches === "undefined") throw new Error("profile storage unavailable");
      const c = await caches.open(PROFILE_CACHE);
      const r = await c.match("profiles");
      if (!r) return;
      const j = (await r.json()) as { v?: unknown; profile?: unknown; roots?: unknown; uncertain?: unknown };
      if (!j || (j.v !== undefined && j.v !== 1) || (j.uncertain !== undefined && typeof j.uncertain !== "boolean") || !validProfileName(j.profile) || !j.roots || typeof j.roots !== "object" || Array.isArray(j.roots)) {
        throw new Error("invalid profile snapshot");
      }
      const roots = Object.entries(j.roots);
      if (roots.some(([root, pid]) => !root || !validProfileName(pid))) throw new Error("invalid root profile");
      if (j.uncertain === true) profileRestoreFailed = true;
      // A fresh trusted assignment wins over a slower disk restore.
      if (!globalProfileAssigned) profile = j.profile;
      for (const [root, pid] of roots) {
        if (!assignedRoots.has(root)) rootProfiles.set(root, pid as string);
      }
    })().catch(() => {
      // The unreadable snapshot may describe an incognito session.
      // Only explicitly assigned roots (or a legacy global assignment)
      // may use cookies until the host rebinds the remaining clients.
      profileRestoreFailed = true;
    });
  }
  return jarProfilesPromise;
}

function persistJarProfiles(): void {
  profilePersistChain = profilePersistChain.then(async () => {
    // Restore untouched roots before writing, otherwise a host pushing
    // one root at boot could erase another window's session profile.
    await jarProfilesReady();
    if (typeof caches === "undefined") return;
    const snapshot = { v: 1, profile, roots: Object.fromEntries(rootProfiles), uncertain: profileRestoreFailed };
    const c = await caches.open(PROFILE_CACHE);
    await c.put("profiles", new Response(JSON.stringify(snapshot)));
  }).catch(() => {
    // Preserve memory state and allow a later trusted push to retry.
  });
}

function profileNameForNamespace(namespace: string): string {
  if (namespace === PROFILE_DEFAULT) return PROFILE_DEFAULT;
  const clientNamespace = namespace.startsWith("client:");
  const rest = clientNamespace ? namespace.slice("client:".length) : namespace;
  const value = clientNamespace
    ? rest.slice(rest.lastIndexOf(":") + 1)
    : rest.startsWith("legacy:")
      ? rest.slice("legacy:".length)
      : rest;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Internal jar-map key for the selected namespace. */
function jarKey(originId: string, namespace = PROFILE_DEFAULT): string {
  return namespace === PROFILE_DEFAULT ? originId : namespace + SEP + originId;
}

/** True when a stored jar-map key belongs to the selected namespace
    (default-profile keys are bare origin ids, predating profiles). */
function inProfile(key: string, namespace = PROFILE_DEFAULT): boolean {
  return namespace === PROFILE_DEFAULT ? !key.includes(SEP) : key.startsWith(namespace + SEP);
}

function clearNamespace(namespace: string): void {
  for (const key of [...jars.keys()]) if (key.startsWith(namespace + SEP)) jars.delete(key);
}

/* The initial opaque navigation may have an empty FetchEvent.clientId.
   This short-lived mapping carries the host identity to its resulting
   proxied document without accepting page-supplied client ids. */
const navHandleRoots = new Map<string, { root: string; expires: number }>();

function navHandleToken(routeUrl: string | undefined): string | null {
  if (!routeUrl) return null;
  try {
    const path = routeUrl.startsWith("/") ? routeUrl.split(/[?#]/, 1)[0] : new URL(routeUrl).pathname;
    return /^\/__zl_navh__\/([^/]+)/.exec(path)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function registerJarNavHandle(routeUrl: string, clientId?: string): void {
  const root = rootOf(clientId) ?? clientId ?? null;
  const token = navHandleToken(routeUrl);
  if (!root || !rootProfiles.has(root) || !token) return;
  const now = Date.now();
  for (const [key, value] of navHandleRoots) if (value.expires <= now) navHandleRoots.delete(key);
  navHandleRoots.set(token, { root, expires: now + 120_000 });
  while (navHandleRoots.size > 256) {
    const oldest = navHandleRoots.keys().next().value;
    if (oldest === undefined) break;
    navHandleRoots.delete(oldest);
  }
}

export function inheritJarClient(
  sourceId: string | undefined,
  resultingId: string | undefined,
  routeUrl?: string,
): string | undefined {
  const token = navHandleToken(routeUrl);
  const pending = token ? navHandleRoots.get(token) : undefined;
  if (token && pending) navHandleRoots.delete(token);
  const root = rootOf(sourceId) ?? (
    pending && pending.expires > Date.now() && rootProfiles.has(pending.root) ? pending.root : null
  ) ?? (token ? decodeNavHandleRoot(token) : null);
  if (sourceId && root) {
    clientRoots.set(sourceId, root);
    unboundClients.delete(sourceId);
  }
  if (resultingId) {
    if (root) {
      clientRoots.set(resultingId, root);
      unboundClients.delete(resultingId);
    } else {
      clientRoots.delete(resultingId);
      unboundClients.delete(resultingId);
    }
  }
  return root ?? sourceId;
}

/** Fail closed for an existing proxied client whose authenticated
    host-root token is unavailable (for example an old legacy route).
    #366 regression: only meaningful while a session profile is active
    somewhere. A default-deployment proxied page arrives at a /j/ route
    that carries no root binding, so marking it unbound here made every
    default-mode page cookie-free; with no second jar in existence,
    riding the default jar is the pre-#366 behavior and leaks nothing. */
export function markJarClientUnbound(clientId?: string): void {
  if (clientId && !rootOf(clientId) && anySessionProfileActive()) unboundClients.add(clientId);
}

export function pruneJarClients(activeClientIds: ReadonlySet<string>): void {
  const liveRoots = new Set<string>();
  let prunedProfiles = false;
  for (const [id, root] of clientRoots) if (activeClientIds.has(id)) liveRoots.add(root);
  for (const [root, pid] of rootProfiles) {
    if (!activeClientIds.has(root) && !liveRoots.has(root)) {
      assignedRoots.add(root);
      rootProfiles.delete(root);
      prunedProfiles = true;
      if (pid !== PROFILE_DEFAULT) clearNamespace(namespaceForProfile(pid, root));
    }
  }
  for (const [id, root] of clientRoots) {
    if (!activeClientIds.has(id)) {
      clientRoots.delete(id);
    } else if (!rootProfiles.has(root) && anySessionProfileActive()) {
      /* #366 regression: with no session profile anywhere, a live
         never-profiled binding is default-mode, not unattributable;
         unbinding it here flipped every default-deployment proxied
         page cookie-free after one prune tick. */
      clientRoots.delete(id);
      unboundClients.add(id);
    }
  }
  for (const id of unboundClients) if (!activeClientIds.has(id)) unboundClients.delete(id);
  for (const [token, entry] of navHandleRoots) {
    if (entry.expires <= Date.now() || !rootProfiles.has(entry.root)) navHandleRoots.delete(token);
  }
  /* #394: a pruned root is a profile-state change; persist it or the
     restore would resurrect dead roots after a restart. */
  if (prunedProfiles) persistJarProfiles();
}

/** Switch the active jar profile (zl:jarProfile control message). A
    null, empty or malformed profile means "default". Leaving a
    session profile drops its cookies immediately (incognito
    semantics). The effective profile is returned so the caller can
    report it. */
export function setJarProfile(p: unknown, clientId?: string): { ok: boolean; profile: string } {
  const next =
    typeof p === "string" && p.length > 0 && p.length <= 64 && !p.includes(SEP)
      ? p
      : PROFILE_DEFAULT;
  if (clientId) {
    const root = rootOf(clientId) ?? clientId;
    const prev = rootProfiles.get(root) ?? PROFILE_DEFAULT;
    assignedRoots.add(root);
    rootProfiles.set(root, next);
    clientRoots.set(clientId, root);
    if (prev !== PROFILE_DEFAULT && prev !== next) {
      clearNamespace(namespaceForProfile(prev, root));
    }
    persistJarProfiles();
    return { ok: true, profile: next };
  }
  globalProfileAssigned = true;
  const prev = profile;
  if (prev !== PROFILE_DEFAULT && prev !== next) {
    clearNamespace(namespaceForProfile(prev, null));
  }
  profile = next;
  persistJarProfiles();
  return { ok: true, profile };
}

/** Active profile name (zl:ping echo, drift detection): the
    requesting client's own when known, else the legacy global. */
export function jarProfileState(clientId?: string): string {
  return activeProfile(clientId);
}

/** True when a FetchEvent client is already associated with a host
    root, allowing request handling to avoid an async Client lookup. */
export function jarClientHasRoot(clientId?: string): boolean {
  return !!rootOf(clientId);
}

interface ParsedUrl {
  origin: string;
  host: string;
  path: string;
  secure: boolean;
}

function parseUrl(u: string): ParsedUrl | null {
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return null;
    return {
      origin: p.origin,
      host: p.hostname.toLowerCase(),
      path: p.pathname || "/",
      secure: p.protocol === "https:",
    };
  } catch {
    return null;
  }
}

/* #191: loopback hosts are potentially trustworthy, so browsers treat
   them as a secure context for Secure cookies even over http. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]";
}

/* #191: the origin may carry Secure cookies: https, or a loopback host. */
function isSecureOrigin(u: ParsedUrl): boolean {
  return u.secure || isLoopbackHost(u.host);
}

/* Dotless-Domain heuristic (the PSL gate below covers multi-label
   public suffixes): a Domain with no dot that is not the host itself
   is refused, which blocks TLD-wide cookies (Domain=com) and keeps a
   dotless intranet host from scoping any other host. */
function looksLikeIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function domainMatch(host: string, domain: string): boolean {
  return host === domain || (host.endsWith("." + domain) && !looksLikeIp(host));
}

/* RFC 6265 5.3 step 5, the browsers' rule (PSL via tldts): a cookie
   Domain that is itself a public suffix (com, co.uk, github.io) can
   never be admitted. Unknown hosts resolve to null and never block
   admission here; the dotless refusal in the gate still catches bare
   TLDs when the PSL is not consulted. */
function isPublicSuffix(domain: string): boolean {
  if (!domain.includes(".")) return false;
  return getPublicSuffix(domain, { allowPrivateDomains: true }) === domain;
}

/* Site-for-cookies boundary via the public suffix list (tldts): the
   registrable domain, the same computation browsers use for the
   SameSite site key (private-section suffixes included, so
   b.github.io is its own site). Single-label and IP hosts, and hosts
   the PSL cannot resolve, are their own site. */
function siteOfHost(host: string): string {
  if (looksLikeIp(host) || !host.includes(".")) return host;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/* SameSite gate (2.2 Arsenide, opt-in). Off = attach as before. Under
   "approx": None always passes (admission already required Secure);
   the cookie's effective policy is its attribute, null meaning lax
   (the browser default). Same-site or unknown initiator passes;
   cross-site passes only lax on a top-level navigation. */
function sameSiteAllows(c: Cookie, u: ParsedUrl, ctx?: CookieRequestContext): boolean {
  if (sameSitePolicy !== "approx") return true;
  const effective = c.sameSite ?? "lax";
  if (effective === "none") return true;
  const init = ctx?.initiator ? parseUrl(ctx.initiator) : null;
  if (!init) return true; /* unknown initiator: honest approximation */
  if (siteOfHost(u.host) === siteOfHost(init.host)) return true;
  return effective === "lax" && ctx?.navigation === true;
}

/** RFC 6265 5.1.4 default-path. */
function defaultPath(uriPath: string): string {
  if (!uriPath.startsWith("/")) return "/";
  const last = uriPath.lastIndexOf("/");
  return last <= 0 ? "/" : uriPath.slice(0, last);
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === "/" || reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/");
}

/* RFC 6265 5.1.1 cookie-date parser (the tough-cookie algorithm).
   Cookie dates are not ISO dates: JS Date.parse accepts formats
   the cookie grammar rejects and can reject dates it must accept.
   Tokenize on the RFC 6265 delimiter set (0x9, 0x20-0x2F, 0x3B-0x40,
   0x5B-0x60, 0x7B-0x7E; ":" is NOT a delimiter, it lives inside the
   time token), find time, day-of-month, month and year, apply the
   2-digit-year windowing, and fail closed. */
const COOKIE_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function parseCookieDate(s: string): number | null {
  let hour = -1, minute = -1, second = -1;
  let day = -1, month = -1, year = -1;
  let foundTime = false, foundDay = false, foundMonth = false, foundYear = false;
  let overflowDay = 0;
  for (const tok of s.split(/[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/)) {
    if (!tok) continue;
    if (!foundTime) {
      const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(tok);
      if (m) {
        hour = Number(m[1]);
        minute = Number(m[2]);
        second = m[3] === undefined ? 0 : Number(m[3]);
        foundTime = true;
        continue;
      }
    }
    if (!foundDay) {
      const m = /^(\d{1,2})(?!\d)/.exec(tok);
      if (m) {
        const d = Number(m[1]);
        if (d >= 1 && d <= 31) { day = d; foundDay = true; continue; }
        if (!overflowDay && d >= 60 && d <= 99) { overflowDay = d; continue; }
      }
    }
    if (!foundMonth) {
      const mm = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.exec(tok);
      if (mm) { month = COOKIE_MONTHS[mm[1].toLowerCase()]; foundMonth = true; continue; }
    }
    if (!foundYear) {
      const m = /^(\d{2,4})(?!\d)/.exec(tok);
      if (m) {
        let y = Number(m[1]);
        if (m[1].length === 2) y = y >= 70 ? 1900 + y : 2000 + y;
        year = y; foundYear = true; continue;
      }
    }
  }
  if (overflowDay && day === -1) {
    /* day-of-month > 31: clamp per the 5.1.1 overflow rule */
    day = overflowDay - 1;
    if (day >= 1 && day <= 31) foundDay = true;
  }
  if (!foundTime || !foundDay || !foundMonth || !foundYear) return null;
  if (year < 1601 || hour > 23 || minute > 59 || second > 59) return null;
  return Date.UTC(year, month, day, hour, minute, second);
}

/** Parse and admit one Set-Cookie header for a response URL.
    Rejects (hard gate) any cookie whose Domain does not scope the
    response host. Deletion follows max-age<=0 or an already-past
    expiry. */
function admitCookie(
  responseUrl: string,
  header: string,
  fromScript = false,
  namespace = PROFILE_DEFAULT,
): SetCookieResult {
  const u = parseUrl(responseUrl);
  const semi = header.indexOf(";");
  const pair = (semi < 0 ? header : header.slice(0, semi)).trim();
  const eq = pair.indexOf("=");
  const name = eq > 0 ? pair.slice(0, eq).trim() : "";
  if (!name || !u) {
    DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "set-cookie rejected: malformed" });
    return { name: "", stored: false, deleted: false, rejected: "malformed" };
  }
  const value = eq > 0 ? pair.slice(eq + 1).trim() : "";
  /* #349: control characters never enter the jar. A CR/LF in a
     stored value poisons every later Cookie header built from it
     (fetch Headers reject the whole header), so one cookie can make
     every later request to the domain fail. RFC 6265 cookie-octets
     exclude CTLs outright. */
  if (/[\x00-\x1F\x7F]/.test(name) || /[\x00-\x1F\x7F]/.test(value)) {
    DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "set-cookie rejected: control character in name or value" });
    return { name: "", stored: false, deleted: false, rejected: "control character" };
  }

  let domain = "";
  let hostOnly = true;
  let path = "";
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite | null = null;
  let expires = 0;
  let hasExpires = false;
  let maxAge: number | null = null;

  const rest = semi < 0 ? "" : header.slice(semi + 1);
  for (const part of rest.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    const key = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : p.slice(i + 1).trim();
    switch (key) {
      case "domain": {
        /* RFC 6265 5.2.3: an empty Domain attribute is ignored - the
           cookie stays host-only instead of becoming a bare-host
           domain cookie that subdomains would match. */
        if (val !== "") {
          domain = (val.startsWith(".") ? val.slice(1) : val).toLowerCase();
          hostOnly = false;
        }
        break;
      }
      case "path": {
        if (val.startsWith("/")) path = val;
        break;
      }
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite": {
        const sv = val.toLowerCase();
        sameSite = sv === "strict" ? "strict" : sv === "lax" ? "lax" : sv === "none" ? "none" : null;
        break;
      }
      case "max-age": {
        if (/^-?\d+$/.test(val)) maxAge = Number(val);
        break;
      }
      case "expires": {
        /* 5.1.1 grammar, not Date.parse: cookie dates are their own
           format and the jar must not accept (or reject) them by
           ISO rules. */
        const t = parseCookieDate(val);
        if (t !== null && !Number.isNaN(t)) {
          expires = t;
          hasExpires = true;
        }
        break;
      }
    }
  }

  /* Spec rule: SameSite=None requires Secure. */
  if (sameSite === "none" && !secure) {
    DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "set-cookie rejected: samesite none without secure" });
    return { name, stored: false, deleted: false, rejected: "samesite none without secure" };
  }

  /* #191: a Secure cookie is only admitted from a secure response
     origin (https, or loopback). Browsers refuse it from plain http. */
  if (secure && !isSecureOrigin(u)) {
    DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "set-cookie rejected: secure cookie from insecure origin" });
    return { name, stored: false, deleted: false, rejected: "secure from insecure origin" };
  }

  if (!domain) domain = u.host;
  path = path || defaultPath(u.path);

  /* Isolation hard gate: the cookie may only scope the response host
     (or a parent domain of it), and never a public suffix itself. */
  if (!hostOnly && (isPublicSuffix(domain) || !domainMatch(u.host, domain) || (!domain.includes(".") && domain !== u.host))) {
    DIAG.emit({
      category: "COOKIE",
      cause: "blocked",
      severity: "warning",
      message: "set-cookie rejected: domain does not scope response host",
      url: responseUrl,
    });
    traceDecision({ subsystem: "cookies", original: responseUrl, result: "rejected:domain " + name });
    return { name, stored: false, deleted: false, rejected: "domain" };
  }

  /* #191: RFC 6265bis 4.1.3 name prefixes (case-sensitive). Checked
     before the deletion branch, so a deletion that breaks them is
     refused too. __Secure- needs Secure; __Host- needs Secure, Path=/
     and no Domain attribute (host-only). */
  if (name.startsWith("__Secure-") || name.startsWith("__Host-")) {
    if (!secure) {
      DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "set-cookie rejected: __Secure- or __Host- prefix without secure" });
      return { name, stored: false, deleted: false, rejected: "prefix requires secure" };
    }
  }
  if (name.startsWith("__Host-") && (!hostOnly || path !== "/")) {
    DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "set-cookie rejected: __Host- prefix needs host-only and path /" });
    return { name, stored: false, deleted: false, rejected: "__Host- requires host-only and path /" };
  }

  const now = Date.now();
  /* Deletion: max-age<=0 or an already-past Expires. A session cookie
     (neither attribute) is expiry 0 and never expires. */
  const isDeletion = (maxAge !== null && maxAge <= 0) || (hasExpires && expires <= now);
  const expiry = maxAge !== null ? now + maxAge * 1000 : expires;

  const key = jarKey(registerOrigin(u.origin).id, namespace);
  const jar = jars.get(key) ?? [];
  const sameCookie = (c: Cookie) => c.name === name && c.domain === domain && c.hostOnly === hostOnly && c.path === path;

  if (isDeletion) {
    const before = jar.length;
    /* #337: a document.cookie write never deletes an HttpOnly
       cookie; only a server response retires one. */
    const kept = jar.filter((c) => !sameCookie(c) || (fromScript && c.httpOnly));
    if (kept.length !== before) {
      if (kept.length) jars.set(key, kept);
      else jars.delete(key);
      schedulePersist();
      traceDecision({ subsystem: "cookies", original: responseUrl, result: "deleted " + name });
      return { name, stored: false, deleted: true };
    }
    return { name, stored: false, deleted: false };
  }

  const idx = jar.findIndex(sameCookie);
  /* #337: a document.cookie write never replaces an HttpOnly cookie
     (RFC 6265 5.5: the storage step ignores a script write over an
     HttpOnly cookie of the same identity). */
  if (fromScript && idx >= 0 && jar[idx].httpOnly) {
    DIAG.emit({ category: "COOKIE", cause: "blocked", severity: "warning", message: "document.cookie write refused: HttpOnly cookie" });
    return { name, stored: false, deleted: false, rejected: "httponly" };
  }
  const fresh: Cookie = {
    name,
    value,
    domain,
    hostOnly,
    path,
    secure,
    httpOnly,
    sameSite,
    expires: expiry,
    /* RFC 6265 5.3.11: replacing a cookie keeps the original
       creation-time; only a genuinely new identity gets now. */
    created: idx >= 0 ? jar[idx].created : now,
  };
  if (idx >= 0) jar[idx] = fresh;
  else jar.push(fresh);
  jars.set(key, jar);
  schedulePersist();
  traceDecision({ subsystem: "cookies", original: responseUrl, result: "stored " + name });
  return { name, stored: true, deleted: false };
}

/** Jar header view of a transport Response. Response construction
    drops set-cookie (fetch spec: forbidden response-header name), so
    the vendored transport exposes its raw header pairs on the
    Response object; rebuild a readable Headers from them so the jar
    sees every set-cookie. Plain Responses (no rawHeaders) fall back to
    their own headers. */
export function jarHeaders(resp: Response): Headers {
  const raw = (resp as Response & { rawHeaders?: Array<[string, string]> }).rawHeaders;
  if (!Array.isArray(raw)) return resp.headers;
  const h = new Headers();
  for (const [k, v] of raw) h.append(k, v);
  return h;
}

/** Capture every Set-Cookie header of a response into the jar. This is
    the SW seam: called on every proxied response, before hostile-header
    surgery strips set-cookie from what the page sees. */
export function applySetCookie(responseUrl: string, headers: Headers, clientId?: string): SetCookieResult[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raw = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  const list = raw.length > 0 ? raw : headers.has("set-cookie") ? [headers.get("set-cookie")!] : [];
  /* #366: the shared unbound namespace admits nothing, so unrelated
     unattributable clients can never observe each other's cookies. */
  if (namespaceForClient(clientId) === UNBOUND_GLOBAL_NAMESPACE) return [];
  return list.map((h) => admitCookie(responseUrl, h, false, namespaceForClient(clientId)));
}

/** Assemble the Cookie header value for a request URL, or null when
    the jar has no match. Expired cookies are purged lazily here.
    The optional context carries the initiator (for the opt-in SameSite
    policy) and whether this is a top-level navigation. */
export function cookieHeaderFor(requestUrl: string, ctx?: CookieRequestContext): string | null {
  const u = parseUrl(requestUrl);
  if (!u) return null;
  const now = Date.now();
  let purged = false;
  for (const [key, list] of jars) {
    const keep = list.filter((c) => c.expires === 0 || c.expires > now);
    if (keep.length !== list.length) {
      purged = true;
      if (keep.length) jars.set(key, keep);
      else jars.delete(key);
    }
  }
  if (purged) schedulePersist();
  /* #267: the Cookie header rides the requesting client's profile.
     #366: an unbound client's namespace is cookie-free by design. */
  const namespace = namespaceForClient(ctx?.clientId);
  if (namespace === UNBOUND_GLOBAL_NAMESPACE) return null;
  const matched: Cookie[] = [];
  for (const [key, list] of jars) {
    if (!inProfile(key, namespace)) continue;
    for (const c of list) {
      const domainOk = c.hostOnly ? u.host === c.domain : domainMatch(u.host, c.domain);
      /* #191 pinned deviation: the jar honors Secure strictly - Secure
         cookies attach to https targets only, never plain http loopback
         (suite/e2e/torture.mjs pins this stricter-than-browser behavior;
         browsers do send Secure cookies over loopback). Loopback stays a
         secure origin for ADMITTING, above. */
      if (domainOk && (!c.secure || u.secure) && pathMatch(u.path, c.path) && sameSiteAllows(c, u, ctx)) {
        matched.push(c);
      }
    }
  }
  matched.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  return matched.length ? matched.map((c) => c.name + "=" + c.value).join("; ") : null;
}

/** document.cookie read (RFC 6265 5.4): every cookie whose domain
    and path scope match the document URL, never the HttpOnly ones.
    Expired cookies are filtered out here.
    The page keeps an eventually-consistent cache because the getter
    is synchronous while this jar lives in the SW. */
export function documentCookieRead(pageUrl: string, clientId?: string): string {
  const u = parseUrl(pageUrl);
  if (!u) return "";
  const now = Date.now();
  const namespace = namespaceForClient(clientId);
  /* #366: the shared unbound namespace admits nothing on any seam. */
  if (namespace === UNBOUND_GLOBAL_NAMESPACE) return "";
  const matched: Cookie[] = [];
  for (const [key, list] of jars) {
    if (!inProfile(key, namespace)) continue;
    for (const c of list) {
      if (c.httpOnly || (c.expires !== 0 && c.expires <= now)) continue;
      const domainOk = c.hostOnly ? u.host === c.domain : domainMatch(u.host, c.domain);
      /* RFC 6265 5.4: path scope applies to document.cookie reads
         too, the same match request cookies use. */
      if (domainOk && (!c.secure || u.secure) && pathMatch(u.path, c.path)) matched.push(c);
    }
  }
  /* RFC 6265 5.4: same ordering the Cookie header uses, longer
     paths first then creation order, so document.cookie serializes
     identically to an engine request for the same URL. */
  matched.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  return matched.map((c) => c.name + "=" + c.value).join("; ");
}

/** document.cookie write (RFC 6265 5.6): admission against the page
    URL. A script cannot mint an HttpOnly cookie, so the attribute is
    stripped before admission (spec: ignore it). */
export function documentCookieWrite(pageUrl: string, cookie: string, clientId?: string): SetCookieResult {
  /* #366: the shared unbound namespace admits nothing on any seam,
     so an unattributable client cannot seed cookies that another
     unbound client would then observe. */
  if (namespaceForClient(clientId) === UNBOUND_GLOBAL_NAMESPACE) {
    const pair = cookie.replace(/;\s*httponly\b/gi, "").split(";")[0].trim();
    const eq = pair.indexOf("=");
    return { name: eq > 0 ? pair.slice(0, eq).trim() : pair, stored: false, deleted: false, rejected: "unbound-client" };
  }
  return admitCookie(pageUrl, cookie.replace(/;\s*httponly\b/gi, ""), true, namespaceForClient(clientId));
}

/** #49 (browser.cookies.remove): delete cookie identities from every
    jar entry of the ACTIVE profile, wherever they actually live. The
    extension bridge has already proven each identity applies to the
    API url (permission gate + RFC 6265 matching); a Domain cookie may
    be stored under a sibling origin's jar entry, which admission
    keyed by the API url's own origin can never reach. Returns how
    many cookies were removed. */
export function jarRemoveIdentities(
  ids: Array<{ name: string; domain: string; hostOnly: boolean; path: string }>,
  clientId?: string,
): number {
  const sameIdentity = (c: Cookie) =>
    ids.some(
      (i) => i.name === c.name && i.domain === c.domain && i.hostOnly === c.hostOnly && i.path === c.path,
    );
  let removed = 0;
  const namespace = clientId ? namespaceForClient(clientId) : PROFILE_DEFAULT;
  for (const [key, list] of jars) {
    if (!inProfile(key, namespace)) continue;
    const keep = list.filter((c) => !sameIdentity(c));
    if (keep.length === list.length) continue;
    removed += list.length - keep.length;
    if (keep.length) jars.set(key, keep);
    else jars.delete(key);
  }
  if (removed > 0) {
    schedulePersist();
    for (const i of ids) {
      traceDecision({ subsystem: "cookies", original: "browser.cookies.remove", result: "api-removed " + i.name });
    }
  }
  return removed;
}

/** Jar contents per virtual-origin id, for tests and inspection. The
    view is the active profile only, keyed by the bare origin id (the
    session-export format is unchanged by profiles). */
export function jarSnapshot(clientId?: string): Map<string, Cookie[]> {
  const out = new Map<string, Cookie[]>();
  const namespace = namespaceForClient(clientId);
  for (const [k, v] of jars) {
    if (!inProfile(k, namespace)) continue;
    const id = k.includes(SEP) ? k.slice(k.indexOf(SEP) + 1) : k;
    out.set(id, v.map((c) => ({ ...c })));
  }
  return out;
}

/* ---- jar enumeration + scoped clear (#41: zl:getJars / zl:clearJar) --- */

/** Resolve a host-supplied origin (full URL or origin string) to its
    jar id, or accept a bare id. Null refuses garbage. */
function originIdOf(origin: unknown): string | null {
  if (typeof origin !== "string" || origin.length === 0) return null;
  const u = parseUrl(origin);
  if (u) return registerOrigin(u.origin).id;
  return /^[a-z0-9]+$/.test(origin) ? origin : null;
}

export interface JarOriginView {
  /** Real target origin when known, else null (id-only record). */
  origin: string | null;
  /** Stable internal id (the jar key namespace). */
  id: string;
  cookies: Cookie[];
}

export interface JarProfileView {
  profile: string;
  active: boolean;
  cookies: number;
  origins: JarOriginView[];
}

/** Enumerate every jar that exists, across ALL profiles, each origin's
    cookies copied out (zl:getJars reply body). The active profile is
    always present, empty or not. */
export function jarEnumeration(clientId?: string): JarProfileView[] {
  const byProfile = new Map<string, Map<string, Cookie[]>>();
  const activeNamespace = namespaceForClient(clientId);
  for (const [k, list] of jars) {
    const sep = k.indexOf(SEP);
    const namespace = sep < 0 ? PROFILE_DEFAULT : k.slice(0, sep);
    if (clientId && namespace !== activeNamespace) continue;
    const pid = profileNameForNamespace(namespace);
    const id = sep < 0 ? k : k.slice(sep + 1);
    let m = byProfile.get(pid);
    if (!m) {
      m = new Map<string, Cookie[]>();
      byProfile.set(pid, m);
    }
    m.set(id, list);
  }
  const active = activeProfile(clientId);
  if (!byProfile.has(active)) byProfile.set(active, new Map<string, Cookie[]>());
  const out: JarProfileView[] = [];
  for (const [pid, m] of byProfile) {
    const origins: JarOriginView[] = [];
    let count = 0;
    for (const [id, list] of m) {
      count += list.length;
      origins.push({ origin: originById.get(id) ?? null, id, cookies: list.map((c) => ({ ...c })) });
    }
    origins.sort((a, b) => (a.origin ?? a.id).localeCompare(b.origin ?? b.id));
    out.push({ profile: pid, active: pid === active, cookies: count, origins });
  }
  return out;
}

/** Extension background contexts do not carry a trustworthy window
    client id, so browser.cookies sees only the durable shared jar. */
export function jarDefaultEnumeration(): JarProfileView[] {
  const origins = new Map<string, Cookie[]>();
  for (const [key, list] of jars) {
    if (!inProfile(key, PROFILE_DEFAULT)) continue;
    origins.set(key, list);
  }
  const views: JarOriginView[] = [];
  let count = 0;
  for (const [id, list] of origins) {
    count += list.length;
    views.push({ origin: originById.get(id) ?? null, id, cookies: list.map((c) => ({ ...c })) });
  }
  views.sort((a, b) => (a.origin ?? a.id).localeCompare(b.origin ?? b.id));
  return [{ profile: PROFILE_DEFAULT, active: true, cookies: count, origins: views }];
}

/** zl:clearJar: clear the whole active (or named) jar profile, or one
    origin's cookies inside it. Malformed input is refused, not
    coerced: a destructive op must not fall back to the default
    profile on garbage. Returns honest counts. */
export function jarClearScope(
  profileId: unknown,
  origin: unknown,
  clientId?: string,
): { ok: boolean; error?: string; jars: number; cookies: number } {
  let pid: string;
  if (profileId === undefined || profileId === null) {
    pid = activeProfile(clientId);
  } else if (
    typeof profileId === "string" &&
    profileId.length > 0 &&
    profileId.length <= 64 &&
    !profileId.includes(SEP)
  ) {
    pid = profileId;
  } else {
    return { ok: false, error: "invalid profile", jars: 0, cookies: 0 };
  }
  let id: string | null;
  if (origin === undefined) {
    id = null;
  } else {
    id = originIdOf(origin);
    if (id === null) return { ok: false, error: "invalid origin", jars: 0, cookies: 0 };
  }
  let jarsCleared = 0;
  let cookiesCleared = 0;
  const namespace = namespaceForProfile(pid, rootOf(clientId));
  if (id === null) {
    const scoped = (k: string) => inProfile(k, namespace);
    for (const k of [...jars.keys()]) {
      if (!scoped(k)) continue;
      const list = jars.get(k);
      cookiesCleared += list ? list.length : 0;
      jars.delete(k);
      jarsCleared++;
    }
  } else {
    const k = jarKey(id, namespace);
    const list = jars.get(k);
    if (list) {
      cookiesCleared = list.length;
      jars.delete(k);
      jarsCleared = 1;
    }
  }
  if (jarsCleared > 0 && pid === PROFILE_DEFAULT) schedulePersist();
  return { ok: true, jars: jarsCleared, cookies: cookiesCleared };
}

/* ---- persistence ------------------------------------------------------ */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/* #254: writes serialize on one chain, so an older snapshot can
   never land after a newer one; each write snapshots the live jars
   when its turn arrives, and a rejected write never wedges the
   chain. */
let persistChain: Promise<void> = Promise.resolve();

function persistDiag(err: unknown): void {
  DIAG.failure({
    category: "STORAGE",
    cause: "failure",
    message: "cookie-jar persistence failed",
    technicalReason: String(err),
  });
}

function runPersist(): Promise<void> {
  persistChain = persistChain.then(jarPersist, jarPersist);
  return persistChain;
}

/** #254: durable-before-ack flush for extendable events: cancels the
    pending debounce and awaits one serialized write. Storage errors
    surface as a STORAGE diag and never throw to the caller. */
export async function flushJarPersist(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await runPersist();
  } catch (err) {
    persistDiag(err);
  }
}

function schedulePersist(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    runPersist().catch(persistDiag);
  }, 1000);
}

/** Write the durable jar as one record (debounced via schedulePersist;
    exported for hosts and tests that want a forced flush). Session
    profiles are in-memory only: they never touch IndexedDB. */
export async function jarPersist(): Promise<void> {
  const db = await openDb();
  const entries: Array<[string, Cookie[]]> = [];
  for (const [k, v] of jars) if (!k.includes(SEP)) entries.push([k, v]);
  await idbPut(db, STORE_COOKIES, "jar", entries);
  /* #41: the id -> origin map rides along as its own record so
     enumeration can name origins after a restart.
     #289: only origins actually referenced by durable default-profile
     jars persist. registerOrigin() admits temporary (incognito) profile
     visits too, but their cookie jars are in-memory only - writing
     their origin metadata to IndexedDB would leak which hosts an
     incognito session visited even though its cookies stayed out. */
  const durable = new Set(entries.map(([k]) => k));
  const ids: Array<[string, string]> = [];
  for (const [id, o] of originById) if (durable.has(id)) ids.push([id, o]);
  await idbPut(db, STORE_COOKIES, "origins", ids);
}

/** Shape check for a persisted or imported cookie record: storage
    and host imports are untrusted input, and a malformed cookie
    reaching the matching code would throw mid-request. */
function isStoredCookie(c: unknown): c is Cookie {
  const o = c as Partial<Cookie>;
  return (
    typeof o?.name === "string" &&
    typeof o?.value === "string" &&
    typeof o?.domain === "string" &&
    typeof o?.hostOnly === "boolean" &&
    typeof o?.path === "string" &&
    typeof o?.secure === "boolean" &&
    typeof o?.httpOnly === "boolean" &&
    typeof o?.expires === "number" &&
    typeof o?.created === "number"
  );
}

/** Restore the persisted jar (SW activate). Storage failures mean an
    in-memory jar, never an engine failure. */
export async function jarLoad(): Promise<void> {
  try {
    const db = await openDb();
    const rec = (await idbGet(db, STORE_COOKIES, "jar")) as Array<[string, Cookie[]]> | undefined;
    const ids = (await idbGet(db, STORE_COOKIES, "origins")) as Array<[string, string]> | undefined;
    jars.clear();
    originById.clear();
    if (Array.isArray(ids)) {
      for (const entry of ids) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
          originById.set(entry[0], entry[1]);
        }
      }
    }
    /* #465: legacy hash keys migrate through the persisted origin map.
       Unattributed legacy records retain their unreachable old keys. */
    const oldOrigins = new Map(originById);
    const migrated = new Map<string, string>();
    for (const [id, o] of oldOrigins) migrated.set(originJarId(o), new URL(o).origin);
    originById.clear();
    for (const [k, v] of migrated) originById.set(k, v);
    if (Array.isArray(rec)) {
      for (const entry of rec) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) {
          /* Persisted records are untrusted storage: a corrupted or
             hand-edited record must never reach the matching code (a
             non-string domain would throw mid-request). */
          const list = entry[1].filter(isStoredCookie);
          if (!list.length) continue;
          const sep = entry[0].indexOf(SEP);
          const pid = sep < 0 ? "" : entry[0].slice(0, sep);
          const id = sep < 0 ? entry[0] : entry[0].slice(sep + SEP.length);
          const origin = oldOrigins.get(id);
          const newId = origin ? originJarId(origin) : id;
          if (pid === "") {
            /* default-profile records are bare origin ids, predating
               profiles; they keep that shape. */
            jars.set(newId, list);
          } else if (pid.startsWith("client:") || pid.startsWith("legacy:")) {
            /* #267/#361 namespaced record: the SEP split leaves the
               namespace prefix intact, so reassembly is verbatim. */
            jars.set(pid + SEP + newId, list);
          } else {
            /* #365: records persisted before client isolation are keyed
               by the raw profile name, which matches no namespace the
               new code computes - they were unreachable from every
               profile path (header, enumeration, clear, replace) and
               re-persisted forever. Rekey under the legacy namespace
               so the pre-isolation sessions load readable. Residual:
               a pre-isolation profile literally named "client:..." or
               "legacy:..." still orphans, because a raw name is
               indistinguishable from a namespace prefix. */
            jars.set(namespaceForProfile(pid, null) + SEP + newId, list);
          }
        }
      }
    }
  } catch {
    /* storage unavailable: the jar stays in memory */
  }
}

/** Session import seam (1.7 Sulfide): replace the active profile's jar
    with the given records after shape checks (other profiles are
    untouched). Malformed records are dropped, never admitted. The jar
    is persisted right away. */
export function jarReplace(entries: Array<[string, unknown[]]>, clientId?: string): void {
  const namespace = namespaceForClient(clientId);
  for (const key of [...jars.keys()]) if (inProfile(key, namespace)) jars.delete(key);
  for (const entry of entries) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) {
      /* The doc comment says malformed records are dropped: hold that
         promise per cookie, the same shape check jarLoad uses. */
      const list = entry[1].filter(isStoredCookie);
      if (list.length) jars.set(jarKey(entry[0], namespace), list);
    }
  }
  runPersist().catch(persistDiag);
}

/** Session import merge mode (2.2 Arsenide): merge records into the
    active profile's jars instead of replacing them. Cookie identity is the same
    one admission uses (name+domain+hostOnly+path); a conflict is
    resolved by the rule. Malformed records are dropped, never
    admitted. Returns honest counts for the reply. */
export function jarMerge(
  entries: Array<[string, unknown[]]>,
  rule: JarConflictRule,
  clientId?: string,
): { jars: number; cookies: number; conflicts: number } {
  let jarsTouched = 0;
  let cookies = 0;
  let conflicts = 0;
  const namespace = namespaceForClient(clientId);
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
    const key = entry[0];
    const jar = jars.get(jarKey(key, namespace)) ?? [];
    let touched = false;
    for (const raw of entry[1]) {
      /* 2026-10-11 audit: the same stored-cookie shape gate jarLoad
         uses. The old loose check admitted records missing
         secure/httpOnly/expires/created; an undefined expiry then
         read as never-expired in document.cookie while the
         request-header path purged it as expired. */
      if (!isStoredCookie(raw)) continue;
      const c = raw;
      const sameCookie = (x: Cookie) =>
        x.name === c.name && x.domain === c.domain && x.hostOnly === c.hostOnly && x.path === c.path;
      const idx = jar.findIndex(sameCookie);
      if (idx >= 0) {
        conflicts++;
        if (rule === "import-wins") jar[idx] = c as Cookie;
        else if (rule === "keep-newest" && typeof c.created === "number" && c.created > jar[idx].created) {
          jar[idx] = c as Cookie;
        }
      } else {
        jar.push(c as Cookie);
        cookies++;
      }
      touched = true;
    }
    if (touched) {
      jars.set(jarKey(key, namespace), jar);
      jarsTouched++;
    }
  }
  runPersist().catch(persistDiag);
  return { jars: jarsTouched, cookies, conflicts };
}

/** Teardown: cookies do not survive an engine switch. */
export function jarClear(): void {
  jars.clear();
  registry.clear();
  originById.clear();
  clientRoots.clear();
  rootProfiles.clear();
  navHandleRoots.clear();
  unboundClients.clear();
  profile = PROFILE_DEFAULT;
  runPersist().catch(persistDiag);
}

/** Tests only: drop all state (pending persist timer included). */
export function cookiesResetForTests(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  jars.clear();
  registry.clear();
  originById.clear();
  sameSitePolicy = "off";
  profile = PROFILE_DEFAULT;
  clientRoots.clear();
  rootProfiles.clear();
  navHandleRoots.clear();
  unboundClients.clear();
  persistChain = Promise.resolve();
  profilePersistChain = Promise.resolve();
  jarProfilesPromise = null;
  profileRestoreFailed = false;
  globalProfileAssigned = false;
  assignedRoots.clear();
}

/* #52 detect-only: recognize an Anubis pass-challenge endpoint so the
   SW can flag the moment a solved challenge hands cookies back through
   the ordinary jar. This is NOT challenge solving; the engine stays
   challenge-DETECT only by design. */
export function isPassChallenge(dest: string): boolean {
  try {
    return new URL(dest).pathname === "/.within.website/x/cmd/anubis/api/pass-challenge";
  } catch {
    return false;
  }
}


/** Wait for queued profile snapshot writes. */
export function jarProfilePersistDrain(): Promise<void> { return profilePersistChain; }
