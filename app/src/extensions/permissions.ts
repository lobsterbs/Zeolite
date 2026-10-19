/* Zeolite extension subsystem: permission model.

   Named permissions are validated against the Firefox permission set.
   Host patterns follow the Firefox match-pattern grammar:
   <all_urls> or scheme://host/path, where host may be *, *.domain, or
   a plain host. #277: file patterns carry no host (file:///*). #280:
   the path pattern may use wildcards in any position and is matched
   against the URL path PLUS query string, per the WebExtension
   contract. The PermissionGate is consulted before any privileged
   API executes. */

export const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set([
  "storage", "tabs", "scripting", "cookies", "webRequest",
  "webRequestBlocking", "webRequestFilterResponse", "activeTab",
  "notifications", "contextMenus", "menus", "downloads",
  "downloads.open", "downloads.ui", "history", "bookmarks",
  "management", "unlimitedStorage", "alarms", "idle", "privacy",
  "nativeMessaging", "geolocation", "clipboardRead", "clipboardWrite",
  "find", "browserSettings", "browsingData", "identity", "themes",
  "topSites", "webNavigation", "devtools", "dns", "pkcs11", "proxy",
  "sessions", "sidebarAction", "tabHide", "userScripts",
]);

export function isKnownPermission(p: string): boolean {
  return KNOWN_PERMISSIONS.has(p);
}

/* Matches the export in manifest.ts without a circular import. */
function looksLikeHostPattern(p: string): boolean {
  return p === "<all_urls>" || p.includes("://") || p.startsWith("*.");
}

export interface HostPattern {
  scheme: string;
  host: string;
  path: string;
  all: boolean;
}

export function parseHostPattern(p: string): HostPattern | null {
  if (p === "<all_urls>") return { scheme: "*", host: "*", path: "*", all: true };
  const m = /^(\*|https?|wss?|ftp|file|moz-extension|extension):\/\/([^\/]*)(\/.*)?$/.exec(p);
  if (!m) return null;
  const scheme = m[1] ?? "*";
  /* #280: URL.hostname is lowercased by the URL parser; match patterns
     compare case-insensitively, so normalize at parse time. */
  const host = (m[2] ?? "").toLowerCase();
  const path = m[3] ?? "/*";
  /* #277: a file pattern intentionally has an empty host (file:///...);
     every other scheme requires one. */
  if (host === "" && scheme !== "file") return null;
  if (scheme !== "*" && scheme !== "http" && scheme !== "https" &&
      scheme !== "ws" && scheme !== "wss" && scheme !== "ftp" &&
      scheme !== "file") {
    return null;
  }
  return { scheme, host, path, all: false };
}

/* #280: compile a path pattern into an anchored matcher. Wildcards
   are allowed in any position and any count; every other character is
   a literal, regex specials escaped. The pattern is evaluated against
   pathname + search (the query string), per the WebExtension spec. */
const PATH_SPECIAL = /[^\w\s]/g;
function pathMatcher(pat: string): (p: string) => boolean {
  if (pat === "*" || pat === "/*") return () => true;
  let src = "^";
  for (const c of pat) {
    if (c === "*") src += "[\\s\\S]*";
    else src += c.replace(PATH_SPECIAL, "\\$&");
  }
  const re = new RegExp(src + "$");
  return (p: string) => re.test(p);
}

/* #277/#280: the documented scheme sets. <all_urls> covers every
   supported scheme including file; the wildcard scheme stays on the
   web + WebSocket schemes and never matches ftp or file. */
const ALL_URLS_SCHEMES: ReadonlySet<string> =
  new Set(["http:", "https:", "ws:", "wss:", "ftp:", "file:"]);
const WILDCARD_SCHEMES: ReadonlySet<string> =
  new Set(["http:", "https:", "ws:", "wss:"]);

export function hostPatternMatches(pat: HostPattern, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (pat.all) {
    return ALL_URLS_SCHEMES.has(u.protocol);
  }
  if (pat.scheme === "*") {
    if (!WILDCARD_SCHEMES.has(u.protocol)) return false;
  } else if (pat.scheme + ":" !== u.protocol) {
    return false;
  }
  /* #277: file patterns carry no host, so no host check applies. */
  if (pat.scheme !== "file") {
    const hostOk =
      pat.host === "*" ||
      u.hostname === pat.host ||
      (pat.host.startsWith("*.") &&
        (u.hostname === pat.host.slice(2) || u.hostname.endsWith(pat.host.slice(1))));
    if (!hostOk) return false;
  }
  return pathMatcher(pat.path)(u.pathname + u.search);
}

export function hostPatternsMatch(patterns: string[], url: string): boolean {
  for (const p of patterns) {
    const pat = parseHostPattern(p);
    if (pat && hostPatternMatches(pat, url)) return true;
  }
  return false;
}

export class PermissionGate {
  private readonly perms: ReadonlySet<string>;
  private readonly hosts: string[];

  constructor(permissions: string[], hostPermissions: string[]) {
    this.perms = new Set(permissions);
    this.hosts = hostPermissions;
  }

  has(p: string): boolean {
    return this.perms.has(p);
  }

  hasHost(url: string): boolean {
    return hostPatternsMatch(this.hosts, url);
  }

  require(p: string): void {
    if (!this.perms.has(p)) {
      throw new Error("zeolite: permission '" + p + "' not granted to this extension");
    }
  }

  requireHost(url: string): void {
    if (!this.hasHost(url)) {
      throw new Error("zeolite: host permission for '" + url + "' not granted to this extension");
    }
  }

  validate(requested: string[], diags: { warnings: string[] }): void {
    for (const p of requested) {
      if (!looksLikeHostPattern(p) && !isKnownPermission(p)) {
        diags.warnings.push("unknown permission: " + p);
      }
    }
  }
}
