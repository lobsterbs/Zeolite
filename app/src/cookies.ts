/* Per-origin cookie jars + virtual-origin registry (Phase 4, 1.4).

   One cookie store partitioned by the virtual-origin registry:
   each target origin gets a stable internal id (the FNV1a hash
   the bootstrap uses for storage scoping). Cookies attach to a
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

import { encodeDest } from "./codec";
import { DIAG } from "./diag";
import { traceDecision } from "./tracing";
import { openDb, idbGet, idbPut, STORE_COOKIES } from "./extensions/idb";

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
  /** Stable internal id (FNV1a base36, same as bootstrap storage). */
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

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Register (memoized) a target origin and its internal representation. */
export function registerOrigin(origin: string): VirtualOrigin {
  let e = registry.get(origin);
  if (!e) {
    e = { origin, id: fnv1a(origin), pathBase: encodeDest(origin) };
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
const SEP = "\u0000";
let profile = PROFILE_DEFAULT;

/** Internal jar map key for the active profile. */
function jarKey(originId: string): string {
  return profile === PROFILE_DEFAULT ? originId : profile + SEP + originId;
}

/** True when a stored jar-map key belongs to the active profile
    (default-profile keys are bare origin ids, predating profiles). */
function inProfile(key: string): boolean {
  return profile === PROFILE_DEFAULT ? !key.includes(SEP) : key.startsWith(profile + SEP);
}

/** Switch the active jar profile (zl:jarProfile control message). A
    null, empty or malformed profile means "default". Leaving a
    session profile drops its cookies immediately (incognito
    semantics). The effective profile is returned so the caller can
    report it. */
export function setJarProfile(p: unknown): { ok: boolean; profile: string } {
  const next =
    typeof p === "string" && p.length > 0 && p.length <= 64 && !p.includes(SEP)
      ? p
      : PROFILE_DEFAULT;
  const prev = profile;
  if (prev !== PROFILE_DEFAULT && prev !== next) {
    for (const key of [...jars.keys()]) if (key.startsWith(prev + SEP)) jars.delete(key);
  }
  profile = next;
  return { ok: true, profile };
}

/** Active profile name (zl:ping echo, drift detection). */
export function jarProfileState(): string {
  return profile;
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

/* ponytail: dotless-Domain heuristic instead of a public-suffix list:
   a Domain with no dot that is not the host itself is refused, which
   blocks TLD-wide cookies (Domain=com). A real PSL replaces this if
   a site ever legitimately needs it. */
function looksLikeIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function domainMatch(host: string, domain: string): boolean {
  return host === domain || (host.endsWith("." + domain) && !looksLikeIp(host));
}

/* ponytail: site-for-cookies approximation without a public-suffix list:
   the last two host labels (single-label and IP hosts are their own
   site), the same approximation the domain gate already relies on. */
function siteOfHost(host: string): string {
  if (looksLikeIp(host) || !host.includes(".")) return host;
  const parts = host.split(".");
  return parts.slice(-2).join(".");
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

/** Parse and admit one Set-Cookie header for a response URL.
    Rejects (hard gate) any cookie whose Domain does not scope the
    response host. Deletion follows max-age<=0 or an already-past
    expiry. */
function admitCookie(responseUrl: string, header: string): SetCookieResult {
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
        domain = val.replace(/^\./, "").toLowerCase();
        hostOnly = false;
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
        const t = Date.parse(val);
        if (!Number.isNaN(t)) {
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

  if (!domain) domain = u.host;
  path = path || defaultPath(u.path);

  /* Isolation hard gate: the cookie may only scope the response host
     (or a parent domain of it). */
  if (!hostOnly && (!domainMatch(u.host, domain) || (!domain.includes(".") && domain !== u.host))) {
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

  const now = Date.now();
  /* Deletion: max-age<=0 or an already-past Expires. A session cookie
     (neither attribute) is expiry 0 and never expires. */
  const isDeletion = (maxAge !== null && maxAge <= 0) || (hasExpires && expires <= now);
  const expiry = maxAge !== null ? now + maxAge * 1000 : expires;

  const key = jarKey(registerOrigin(u.origin).id);
  const jar = jars.get(key) ?? [];
  const sameCookie = (c: Cookie) => c.name === name && c.domain === domain && c.hostOnly === hostOnly && c.path === path;

  if (isDeletion) {
    const before = jar.length;
    const kept = jar.filter((c) => !sameCookie(c));
    if (kept.length !== before) {
      if (kept.length) jars.set(key, kept);
      else jars.delete(key);
      schedulePersist();
      traceDecision({ subsystem: "cookies", original: responseUrl, result: "deleted " + name });
      return { name, stored: false, deleted: true };
    }
    return { name, stored: false, deleted: false };
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
    created: now,
  };
  const idx = jar.findIndex(sameCookie);
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
export function applySetCookie(responseUrl: string, headers: Headers): SetCookieResult[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raw = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  const list = raw.length > 0 ? raw : headers.has("set-cookie") ? [headers.get("set-cookie")!] : [];
  return list.map((h) => admitCookie(responseUrl, h));
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
  const matched: Cookie[] = [];
  for (const [key, list] of jars) {
    if (!inProfile(key)) continue;
    for (const c of list) {
      const domainOk = c.hostOnly ? u.host === c.domain : domainMatch(u.host, c.domain);
      if (domainOk && (!c.secure || u.secure) && pathMatch(u.path, c.path) && sameSiteAllows(c, u, ctx)) {
        matched.push(c);
      }
    }
  }
  matched.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  return matched.length ? matched.map((c) => c.name + "=" + c.value).join("; ") : null;
}

/** document.cookie read (RFC 6265 5.4): every cookie that
    domain-and-scope matches the document origin, regardless of path,
    never the HttpOnly ones. Expired cookies are filtered out here.
    The page keeps an eventually-consistent cache because the getter
    is synchronous while this jar lives in the SW. */
export function documentCookieRead(pageUrl: string): string {
  const u = parseUrl(pageUrl);
  if (!u) return "";
  const now = Date.now();
  const matched: Cookie[] = [];
  for (const [key, list] of jars) {
    if (!inProfile(key)) continue;
    for (const c of list) {
      if (c.httpOnly || (c.expires !== 0 && c.expires <= now)) continue;
      const domainOk = c.hostOnly ? u.host === c.domain : domainMatch(u.host, c.domain);
      if (domainOk && (!c.secure || u.secure)) matched.push(c);
    }
  }
  matched.sort((a, b) => a.created - b.created);
  return matched.map((c) => c.name + "=" + c.value).join("; ");
}

/** document.cookie write (RFC 6265 5.6): admission against the page
    URL. A script cannot mint an HttpOnly cookie, so the attribute is
    stripped before admission (spec: ignore it). */
export function documentCookieWrite(pageUrl: string, cookie: string): SetCookieResult {
  return admitCookie(pageUrl, cookie.replace(/;\s*httponly\b/gi, ""));
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
): number {
  const sameIdentity = (c: Cookie) =>
    ids.some(
      (i) => i.name === c.name && i.domain === c.domain && i.hostOnly === c.hostOnly && i.path === c.path,
    );
  let removed = 0;
  for (const [key, list] of jars) {
    if (!inProfile(key)) continue;
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
export function jarSnapshot(): Map<string, Cookie[]> {
  const out = new Map<string, Cookie[]>();
  for (const [k, v] of jars) {
    if (!inProfile(k)) continue;
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
export function jarEnumeration(): JarProfileView[] {
  const byProfile = new Map<string, Map<string, Cookie[]>>();
  for (const [k, list] of jars) {
    const sep = k.indexOf(SEP);
    const pid = sep < 0 ? PROFILE_DEFAULT : k.slice(0, sep);
    const id = sep < 0 ? k : k.slice(sep + 1);
    let m = byProfile.get(pid);
    if (!m) {
      m = new Map<string, Cookie[]>();
      byProfile.set(pid, m);
    }
    m.set(id, list);
  }
  if (!byProfile.has(profile)) byProfile.set(profile, new Map<string, Cookie[]>());
  const out: JarProfileView[] = [];
  for (const [pid, m] of byProfile) {
    const origins: JarOriginView[] = [];
    let count = 0;
    for (const [id, list] of m) {
      count += list.length;
      origins.push({ origin: originById.get(id) ?? null, id, cookies: list.map((c) => ({ ...c })) });
    }
    origins.sort((a, b) => (a.origin ?? a.id).localeCompare(b.origin ?? b.id));
    out.push({ profile: pid, active: pid === profile, cookies: count, origins });
  }
  return out;
}

/** zl:clearJar: clear the whole active (or named) jar profile, or one
    origin's cookies inside it. Malformed input is refused, not
    coerced: a destructive op must not fall back to the default
    profile on garbage. Returns honest counts. */
export function jarClearScope(
  profileId: unknown,
  origin: unknown,
): { ok: boolean; error?: string; jars: number; cookies: number } {
  let pid: string;
  if (profileId === undefined || profileId === null) {
    pid = profile;
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
  if (id === null) {
    const scoped = (k: string) =>
      pid === PROFILE_DEFAULT ? !k.includes(SEP) : k.startsWith(pid + SEP);
    for (const k of [...jars.keys()]) {
      if (!scoped(k)) continue;
      const list = jars.get(k);
      cookiesCleared += list ? list.length : 0;
      jars.delete(k);
      jarsCleared++;
    }
  } else {
    const k = pid === PROFILE_DEFAULT ? id : pid + SEP + id;
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

function schedulePersist(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    jarPersist().catch(() => undefined);
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
     enumeration can name origins after a restart. */
  const ids: Array<[string, string]> = [];
  for (const [id, o] of originById) ids.push([id, o]);
  await idbPut(db, STORE_COOKIES, "origins", ids);
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
    if (Array.isArray(rec)) {
      for (const entry of rec) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) {
          jars.set(entry[0], entry[1]);
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
export function jarReplace(entries: Array<[string, unknown[]]>): void {
  for (const key of [...jars.keys()]) if (inProfile(key)) jars.delete(key);
  for (const entry of entries) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) {
      jars.set(jarKey(entry[0]), entry[1] as Cookie[]);
    }
  }
  jarPersist().catch(() => undefined);
}

/** Session import merge mode (2.2 Arsenide): merge records into the
    active profile's jars instead of replacing them. Cookie identity is the same
    one admission uses (name+domain+hostOnly+path); a conflict is
    resolved by the rule. Malformed records are dropped, never
    admitted. Returns honest counts for the reply. */
export function jarMerge(
  entries: Array<[string, unknown[]]>,
  rule: JarConflictRule,
): { jars: number; cookies: number; conflicts: number } {
  let jarsTouched = 0;
  let cookies = 0;
  let conflicts = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
    const key = entry[0];
    const jar = jars.get(jarKey(key)) ?? [];
    let touched = false;
    for (const raw of entry[1]) {
      const c = raw as Partial<Cookie>;
      if (
        typeof c?.name !== "string" ||
        typeof c?.domain !== "string" ||
        typeof c?.hostOnly !== "boolean" ||
        typeof c?.path !== "string" ||
        typeof c?.value !== "string"
      ) {
        continue;
      }
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
      jars.set(jarKey(key), jar);
      jarsTouched++;
    }
  }
  jarPersist().catch(() => undefined);
  return { jars: jarsTouched, cookies, conflicts };
}

/** Teardown: cookies do not survive an engine switch. */
export function jarClear(): void {
  jars.clear();
  registry.clear();
  originById.clear();
  jarPersist().catch(() => undefined);
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
