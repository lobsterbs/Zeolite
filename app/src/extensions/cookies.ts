/* Zeolite extension subsystem: cookies bridge.

   browser.cookies.* over the engine's virtual cookie jar
   (../../cookies.ts), permission-gated like webRequest: the
   "cookies" permission mounts the namespace, and every read or
   write additionally needs a host permission matching the target
   URL. Writes go through the same admission seam as document.cookie
   (documentCookieWrite), so the isolation/domain/SameSite gates are
   enforced once, centrally - and HttpOnly stays unmintable from
   script, documented honestly in compat.ts. Reads see the ACTIVE
   jar profile (the one proxied pages see); id-only jar records
   (origin string unknown) cannot be permission-checked, so they stay
   invisible to extensions. */

import type { ExtensionRecord } from "./types";
import { hostPatternsMatch } from "./permissions";
import { documentCookieWrite, jarEnumeration } from "../cookies";
import type { Cookie } from "../cookies";

interface UrlFacts {
  host: string;
  path: string;
  secure: boolean;
}

function urlFacts(u: string): UrlFacts | null {
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return null;
    return {
      host: p.hostname.toLowerCase(),
      path: p.pathname || "/",
      secure: p.protocol === "https:",
    };
  } catch {
    return null;
  }
}

/* Same match rule the jar's admission uses (cookies.ts). */
function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith("." + domain) && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === "/" || reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/");
}

/** Does this cookie apply to the URL (domain, secure, expiry)? */
function applies(c: Cookie, f: UrlFacts, now: number): boolean {
  if (c.expires !== 0 && c.expires <= now) return false;
  if (c.secure && !f.secure) return false;
  return c.hostOnly ? f.host === c.domain : domainMatch(f.host, c.domain);
}

/** Firefox Cookie view of one jar cookie. */
function view(c: Cookie): Record<string, unknown> {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.sameSite ? { sameSite: c.sameSite === "none" ? "no_restriction" : c.sameSite } : {}),
    ...(c.expires !== 0 ? { expirationDate: c.expires / 1000 } : {}),
    sessionId: c.expires === 0,
  };
}

/** Active-profile jar with real origin strings. */
function activeOrigins(): Array<{ origin: string; cookies: Cookie[] }> {
  const p = jarEnumeration().find((x) => x.active);
  const out: Array<{ origin: string; cookies: Cookie[] }> = [];
  if (!p) return out;
  for (const o of p.origins) {
    if (o.origin) out.push({ origin: o.origin, cookies: o.cookies });
  }
  return out;
}

/** Permission + shape gate shared by every call. Returns the parsed
    URL facts, or an error string. */
function gate(ext: ExtensionRecord, url: unknown): UrlFacts | string {
  if (!ext.permissions.includes("cookies")) {
    return "zeolite: permission 'cookies' not granted to this extension";
  }
  if (typeof url !== "string") return "zeolite: cookies requires a url";
  const f = urlFacts(url);
  if (!f) return "zeolite: cookies requires an http(s) url";
  if (!hostPatternsMatch(ext.hostPermissions, url)) {
    return "zeolite: host permission for '" + url + "' not granted to this extension";
  }
  return f;
}

export function cookiesGet(
  ext: ExtensionRecord,
  details: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const g = gate(ext, details?.url);
  if (typeof g === "string") return Promise.reject(new Error(g));
  const name = details?.name;
  if (typeof name !== "string" || name.length === 0) {
    return Promise.reject(new Error("zeolite: cookies.get requires a name"));
  }
  const f = g;
  const now = Date.now();
  let best: Cookie | null = null;
  for (const { cookies } of activeOrigins()) {
    for (const c of cookies) {
      if (c.name !== name || !applies(c, f, now) || !pathMatch(f.path, c.path)) continue;
      /* RFC 6265 ordering: longest path wins, then the newest. */
      if (!best || c.path.length > best.path.length ||
        (c.path.length === best.path.length && c.created > best.created)) {
        best = c;
      }
    }
  }
  return Promise.resolve(best ? view(best) : null);
}

export function cookiesGetAll(
  ext: ExtensionRecord,
  details: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const now = Date.now();
  const name = typeof details.name === "string" ? details.name : null;
  const domain = typeof details.domain === "string"
    ? details.domain.replace(/^\./, "").toLowerCase()
    : null;
  const path = typeof details.path === "string" ? details.path : null;
  const secure = details.secure === undefined ? null : details.secure === true;
  const httpOnly = details.httpOnly === undefined ? null : details.httpOnly === true;
  const sameSite = typeof details.sameSite === "string"
    ? details.sameSite === "no_restriction" ? "none" : details.sameSite
    : null;
  const matches = (c: Cookie): boolean => {
    if (name && c.name !== name) return false;
    if (domain && !(c.domain === domain || c.domain.endsWith("." + domain))) return false;
    if (path && c.path !== path) return false;
    if (secure !== null && c.secure !== secure) return false;
    if (httpOnly !== null && c.httpOnly !== httpOnly) return false;
    if (sameSite && c.sameSite !== sameSite) return false;
    return true;
  };
  const out: Record<string, unknown>[] = [];
  if (typeof details.url === "string") {
    const g = gate(ext, details.url);
    if (typeof g === "string") return Promise.reject(new Error(g));
    const f = g;
    for (const { cookies } of activeOrigins()) {
      for (const c of cookies) {
        if (applies(c, f, now) && pathMatch(f.path, c.path) && matches(c)) out.push(view(c));
      }
    }
    return Promise.resolve(out);
  }
  /* No url: every origin the extension holds a host permission for. */
  for (const { origin, cookies } of activeOrigins()) {
    if (!hostPatternsMatch(ext.hostPermissions, origin)) continue;
    for (const c of cookies) {
      if (c.expires !== 0 && c.expires <= now) continue;
      if (matches(c)) out.push(view(c));
    }
  }
  return Promise.resolve(out);
}

export function cookiesSet(
  ext: ExtensionRecord,
  details: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const g = gate(ext, details?.url);
  if (typeof g === "string") return Promise.reject(new Error(g));
  const name = details?.name;
  const value = details?.value;
  if (typeof name !== "string" || !name || /[\s;,]/.test(name)) {
    return Promise.reject(new Error("zeolite: cookies.set requires a clean name"));
  }
  if (typeof value !== "string" || /[\r\n;]/.test(value)) {
    return Promise.reject(new Error("zeolite: cookies.set requires a clean value"));
  }
  const parts: string[] = [name + "=" + value];
  if (typeof details.domain === "string" && details.domain) {
    parts.push("Domain=" + details.domain.replace(/^\./, ""));
  }
  parts.push("Path=" + (typeof details.path === "string" && details.path.startsWith("/") ? details.path : "/"));
  if (details.secure === true) parts.push("Secure");
  if (details.sameSite === "no_restriction") parts.push("SameSite=None");
  else if (details.sameSite === "lax") parts.push("SameSite=Lax");
  else if (details.sameSite === "strict") parts.push("SameSite=Strict");
  if (typeof details.expirationDate === "number" && details.expirationDate > 0) {
    parts.push("Expires=" + new Date(details.expirationDate * 1000).toUTCString());
  }
  /* documentCookieWrite strips httpOnly: a script context cannot
     mint an HttpOnly cookie (documented in compat.ts). A rejected
     write (domain not scoping the host, samesite none without
     secure, ...) resolves to null, never a fake view. */
  const r = documentCookieWrite(String(details.url), parts.join("; "));
  if (!r.stored && !r.deleted) return Promise.resolve(null);
  return cookiesGet(ext, { url: details.url, name });
}

export function cookiesRemove(
  ext: ExtensionRecord,
  details: Record<string, unknown>,
): Promise<{ url: string; name: string } | null> {
  const g = gate(ext, details?.url);
  if (typeof g === "string") return Promise.reject(new Error(g));
  const name = details?.name;
  if (typeof name !== "string" || name.length === 0) {
    return Promise.reject(new Error("zeolite: cookies.remove requires a name"));
  }
  const f = g;
  const now = Date.now();
  /* One deletion per (domain, hostOnly, path) identity: the same
     name can exist at several paths. */
  const targets = new Set<string>();
  for (const { cookies } of activeOrigins()) {
    for (const c of cookies) {
      if (c.name === name && applies(c, f, now) && pathMatch(f.path, c.path)) {
        targets.add(c.domain + "|" + (c.hostOnly ? "1" : "0") + "|" + c.path);
      }
    }
  }
  if (!targets.size) return Promise.resolve(null);
  for (const t of targets) {
    const [domain, hostOnly, cpath] = t.split("|");
    const parts = [name + "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "Path=" + cpath];
    if (hostOnly === "0") parts.push("Domain=" + domain);
    documentCookieWrite(String(details.url), parts.join("; "));
  }
  return Promise.resolve({ url: String(details.url), name });
}
