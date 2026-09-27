/* Per-origin cookie jars + virtual-origin registry (Phase 4, 1.4 Boride).

   The engine owns one cookie store, partitioned by the virtual-origin
   registry: every target origin gets a stable internal id (the same
   FNV1a hash the bootstrap uses for storage scoping) and its
   Zeolite-internal representation (the codec encoding of the origin).
   Cookies are stored as records under that id; matching is the ONLY
   way cookies cross records: a cookie attaches to a request when its
   own Domain/Path/Secure attributes say so (RFC 6265 domain-match and
   path-match). A cookie is never admitted outside its domain scope
   and never attached outside it, so unrelated target origins are
   isolated by construction. That is the hard gate.

   Honesty notes (docs/cookies.md):
   - Redirect hops followed inside the transport never surface here:
     the jar sees every request the engine initiates and every final
     response, not intermediate 3xx hops.
   - SameSite is parsed and stored but not enforced: every proxied
     request is engine-initiated and has no meaningful site-for-sites
     context. SameSite=None without Secure is rejected (spec rule).
   - document.cookie is not virtualized yet (Phase 5 scope).
   - The transport (libcurl) may hold cookies internally; this jar is
     the engine's authoritative Cookie source for requests it
     initiates.

   Persistence: IndexedDB (service workers have no localStorage),
   reusing the extension subsystem's idb helper; the whole jar is one
   record, rewritten (debounced) after mutations. */

import { encodeDest } from "./codec";
import { DIAG } from "./diag";
import { traceDecision } from "./tracing";
import { openDb, idbGet, idbPut, STORE_COOKIES } from "./extensions/idb";

export type SameSite = "strict" | "lax" | "none";

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
  }
  return e;
}

/* ---- jar ------------------------------------------------------------- */

/** jar key = virtual-origin id of the origin the cookie was SET from. */
const jars = new Map<string, Cookie[]>();

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

  const key = registerOrigin(u.origin).id;
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
    the jar has no match. Expired cookies are purged lazily here. */
export function cookieHeaderFor(requestUrl: string): string | null {
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
  for (const list of jars.values()) {
    for (const c of list) {
      const domainOk = c.hostOnly ? u.host === c.domain : domainMatch(u.host, c.domain);
      if (domainOk && (!c.secure || u.secure) && pathMatch(u.path, c.path)) matched.push(c);
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
  for (const list of jars.values()) {
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

/** Jar contents per virtual-origin id, for tests and inspection. */
export function jarSnapshot(): Map<string, Cookie[]> {
  const out = new Map<string, Cookie[]>();
  for (const [k, v] of jars) out.set(k, v.map((c) => ({ ...c })));
  return out;
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

/** Write the whole jar as one record (debounced via schedulePersist;
    exported for hosts and tests that want a forced flush). */
export async function jarPersist(): Promise<void> {
  const db = await openDb();
  const entries: Array<[string, Cookie[]]> = [];
  for (const [k, v] of jars) entries.push([k, v]);
  await idbPut(db, STORE_COOKIES, "jar", entries);
}

/** Restore the persisted jar (SW activate). Storage failures mean an
    in-memory jar, never an engine failure. */
export async function jarLoad(): Promise<void> {
  try {
    const db = await openDb();
    const rec = (await idbGet(db, STORE_COOKIES, "jar")) as Array<[string, Cookie[]]> | undefined;
    jars.clear();
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

/** Teardown: cookies do not survive an engine switch. */
export function jarClear(): void {
  jars.clear();
  registry.clear();
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
}
