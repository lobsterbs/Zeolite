/* Zeolite extension subsystem: asset serving.

   Same-origin routes stand in for extension://:

   /zl-ext/<id>/<path>  web_accessible_resources (fromWeb checks);
                        with a valid page token or from a registered
                        page client also extension pages (options,
                        popup, #40) with the page bridge injected
   /zl-cs/<id>/<path>   content-script files: ONLY paths the manifest
                        declares in content_scripts entries that MATCH
                        the requesting virtual page (#285), so a page
                        can never pull background, options, manifest
                        files, or another site's scripts through this
                        route.

   __bridge.js under /zl-cs/ is generated per request with the config
   (which files, which run_at) validated against the page-matching
   entries before the bridge source is emitted. __page.js under
   /zl-ext/ is generated per extension with the page call list (#40). */

import { extensions } from "./manager";
import { normalizeExtensionPath } from "./origin";
import { contentScriptMatches } from "./content-scripts";
import { BRIDGE_SOURCE } from "./bridge";
import { LISTENER_SOURCE } from "./scripting";
import { PAGE_BRIDGE_SOURCE } from "./pagebridge";
import { ACTION } from "./action";
import { pageCallList, pageNamespaceList } from "./pageapi";
import { resolvePackageI18n } from "./i18n";
import type { ExtensionRecord } from "./types";

export const EXT_ROUTE = "/zl-ext/";
export const CS_ROUTE = "/zl-cs/";

export type ServeReq =
  | { kind: "war"; id: string; path: string }
  | { kind: "pagejs"; id: string }
  | { kind: "bridge"; id: string }
  | { kind: "cs"; id: string; path: string }
  | { kind: "listener"; id: string };

const EXT_ID_RE = /^[a-f0-9]{32}$/;

export function parseServePath(pathname: string): ServeReq | null {
  if (pathname === CS_ROUTE + "__scripting.js") return { kind: "listener", id: "" };
  if (pathname.startsWith(EXT_ROUTE)) {
    const rest = pathname.slice(EXT_ROUTE.length);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    const p = slash === -1 ? "/" : rest.slice(slash);
    if (!EXT_ID_RE.test(id)) return null;
    if (p === "/__page.js") return { kind: "pagejs", id };
    const norm = normalizeExtensionPath(p);
    return norm ? { kind: "war", id, path: norm } : null;
  }
  if (pathname.startsWith(CS_ROUTE)) {
    const rest = pathname.slice(CS_ROUTE.length);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    const p = slash === -1 ? "/" : rest.slice(slash);
    if (!EXT_ID_RE.test(id)) return null;
    if (p === "/__bridge.js") return { kind: "bridge", id };
    const norm = normalizeExtensionPath(p);
    return norm ? { kind: "cs", id, path: norm } : null;
  }
  return null;
}

const MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
};

function assetResponse(bytes: Uint8Array, path: string): Response {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const ct = MIME[ext] ?? "application/octet-stream";
  const copy = bytes.slice();
  return new Response(copy.buffer as ArrayBuffer, {
    headers: { "content-type": ct, "cache-control": "no-store" },
  });
}

function notFound(): Response {
  return new Response("zeolite: extension resource not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

/* #40: extension pages are HTML documents; the page bridge is
   injected right after <head> (prepended when no head exists). Only
   .html paths get the injection: a page served from a path without
   an .html suffix has no API bridge (documented in ./compat). */
function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

function htmlWithPageScript(bytes: Uint8Array, id: string): Response {
  const html = new TextDecoder().decode(bytes);
  /* #560: rooted pages (see serveRootedExtPage) are served at the
     origin root, so package-relative subresources would resolve
     against the site path; the base tag re-roots every relative URL
     onto the /zl-ext/<id>/ package route. For /zl-ext/ pages the
     base resolves exactly as the page URL already did. */
  const tag =
    '<base href="' + EXT_ROUTE + id + '/">' +
    '<script src="' + EXT_ROUTE + id + '/__page.js"></script>';
  const m = /<head[^>]*>/i.exec(html);
  const body = m
    ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length)
    : tag + html;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* #285: only files from content_scripts entries whose match rules
   cover the SW-observed requesting page URL. Fail closed: without a
   pageUrl NO content-script asset is served at all. */
function csFilesForPage(rec: ExtensionRecord, pageUrl: string | null | undefined): Set<string> {
  const s = new Set<string>();
  if (!pageUrl) return s;
  for (const cs of rec.contentScripts) {
    if (!contentScriptMatches(cs, pageUrl, false)) continue;
    for (const f of cs.js) s.add(f.startsWith("/") ? f : "/" + f);
    for (const f of cs.css) s.add(f.startsWith("/") ? f : "/" + f);
  }
  return s;
}

interface CsCfg {
  ext?: unknown;
  js?: unknown;
  css?: unknown;
  runAt?: unknown;
}

function isCfg(v: unknown): v is CsCfg {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (Array.isArray(c.js) && c.js.some((x) => typeof x !== "string")) return false;
  if (Array.isArray(c.css) && c.css.some((x) => typeof x !== "string")) return false;
  const r = c.runAt;
  return (
    r === undefined ||
    r === "document_start" ||
    r === "document_end" ||
    r === "document_idle"
  );
}

/* #40: page-token registry. zl:openExtPage (a host-only control
   message in the SW) mints a token for one (extension, path) pair; a
   navigation carrying it is served as an extension page without the
   WAR gate. 5-minute TTL, in-memory only: tokens die with the
   worker, and a token never crosses extensions or paths. */
const PAGE_TOKEN_TTL = 5 * 60 * 1000;
const pageTokens = new Map<string, { extId: string; path: string; minted: number }>();

export function mintPageToken(extId: string, path: string): string {
  const tok = crypto.randomUUID();
  pageTokens.set(tok, { extId, path, minted: Date.now() });
  return tok;
}

export function checkPageToken(extId: string, path: string, token: string): boolean {
  const e = pageTokens.get(token);
  if (!e) return false;
  if (Date.now() - e.minted > PAGE_TOKEN_TTL || e.extId !== extId || e.path !== path) {
    pageTokens.delete(token);
    return false;
  }
  return true;
}

/** Rooted, tokened URL for an extension's options or popup page —
    the host's zl:openExtPage flow (#40) and runtime.openOptionsPage
    (#518) share it, so both open through the same granted navigation.
    For popups the action registry's per-tab/per-default state wins
    over the manifest default. Null when the extension is disabled or
    declares no such page. */
export function extPageOpenUrl(
  rec: ExtensionRecord,
  which: "options" | "popup",
  tabId?: number | null,
): string | null {
  if (!rec.enabled) return null;
  let raw: string | null | undefined = null;
  if (which === "options") {
    raw = rec.options?.page;
  } else {
    const kind = rec.action?.kind;
    raw = kind ? (ACTION.popupFor(rec, kind, tabId) ?? rec.action?.defaultPopup) : rec.action?.defaultPopup;
  }
  if (!raw) return null;
  const norm = normalizeExtensionPath(raw.startsWith("/") ? raw : "/" + raw);
  if (!norm) return null;
  return norm + "?zlExt=" + rec.id + "&zlPageTok=" + mintPageToken(rec.id, norm);
}

/* Registered extension-page clients, keyed by the SW-observed client
   id of a granted navigation. Subresource fetches and zl:extPage
   messages from these clients authenticate as the extension's page.
   ponytail: no TTL, the SW's own lifetime bounds the map; a stale
   entry after a page close is inert because client ids are never
   reassigned. */
const pageClients = new Map<string, string>();

export function registerPageClient(clientId: string | undefined, extId: string): void {
  if (clientId) pageClients.set(clientId, extId);
}

export function pageClientOf(clientId: string | undefined): string | null {
  return clientId ? (pageClients.get(clientId) ?? null) : null;
}

/* #40: serving context for extension-page access. Client ids come
   from the FetchEvent (SW-observed), never from the page. */
/* #560: rooted extension pages. Extension page worlds that dispatch
   their boot on location.pathname (Tampermonkey options/action)
   never match /zl-ext/<id>/... under the engine, so those pages boot
   to a blank body. The engine therefore also serves the same granted
   page at the origin root with the extension id in the query:
   /options.html?zlExt=<id>[&zlPageTok=...]. Grant rules match the
   /zl-ext/ page route: a zl:openExtPage-minted page token, or a
   registered page client of this extension (self-navigation via
   runtime.getURL / window.open from an already-served page).

   rootedPageGrant is the synchronous decision step so the request
   handler can fall through to virtual handling when the engine will
   not serve this request. null ALWAYS means "not mine", including
   invalid tokens and unregistered clients: those must look exactly
   like an unknown extension so the route leaks no extension-id
   oracle. */
export interface RootedPageGrant {
  extId: string;
  path: string;
}

export function rootedPageGrant(
  req: Request,
  url: URL,
  clientId: string | undefined,
): RootedPageGrant | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const extId = url.searchParams.get("zlExt") ?? "";
  if (!EXT_ID_RE.test(extId)) return null;
  const path = normalizeExtensionPath(url.pathname);
  if (path === null || !isHtmlPath(path)) return null;
  const rec = extensions.get(extId);
  if (!rec || !rec.enabled) return null;
  const token = url.searchParams.get("zlPageTok") ?? "";
  if (!(checkPageToken(extId, path, token) || pageClientOf(clientId) === extId)) {
    return null;
  }
  return { extId, path };
}

export async function serveRootedExtPage(
  grant: RootedPageGrant,
  resultingClientId: string | undefined,
): Promise<Response> {
  /* The granted navigation's new client becomes a registered page
     client, exactly like the /zl-ext/ navigation path. */
  registerPageClient(resultingClientId, grant.extId);
  const own = await extensions.getResource(grant.extId, grant.path, { fromWeb: false });
  if (!own) return notFound();
  return htmlWithPageScript(own, grant.extId);
}

export interface ServeCtx {
  nav: boolean;
  clientId?: string;
  resultingClientId?: string;
  /* #51: the requesting page destination, SW-observed from the fetch
     client. MV3 matches-scoped web_accessible_resources are checked
     against it; unknown means the scoped gate fails closed. */
  pageUrl?: string | null;
}

export async function serveExtensionAsset(req: Request, url: URL, ctx?: ServeCtx): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("zeolite: method not allowed", { status: 405 });
  }
  const sr = parseServePath(url.pathname);
  if (!sr) return notFound();
  if (sr.kind === "listener") {
    /* Engine-global scripting listener; not tied to one extension. */
    return new Response(LISTENER_SOURCE, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const rec = extensions.get(sr.id);
  if (!rec || !rec.enabled) return notFound();

  if (sr.kind === "bridge") {
    let cfg: unknown = null;
    try {
      cfg = JSON.parse(url.searchParams.get("cfg") ?? "null");
    } catch {
      /* malformed cfg: refused below */
    }
    if (!isCfg(cfg)) {
      return new Response("zeolite: bad bridge cfg", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    }
    /* #285: the cfg is page-supplied and untrusted; its files are
       validated against the entries that actually match THIS page
       (SW-observed pageUrl), not the manifest-wide union. A page
       outside every entry's match scope gets an empty config. */
    const allowed = csFilesForPage(rec, ctx?.pageUrl);
    const norm = (p: unknown): string | null =>
      typeof p === "string" ? (p.startsWith("/") ? p : "/" + p) : null;
    const js = (Array.isArray(cfg.js) ? cfg.js : [])
      .map(norm)
      .filter((p: string | null): p is string => p !== null && allowed.has(p))
      .map((p) => CS_ROUTE + sr.id + p);
    const css = (Array.isArray(cfg.css) ? cfg.css : [])
      .map(norm)
      .filter((p: string | null): p is string => p !== null && allowed.has(p))
      .map((p) => CS_ROUTE + sr.id + p);
    const runAt =
      cfg.runAt === "document_start" || cfg.runAt === "document_end"
        ? cfg.runAt
        : "document_idle";
    const body =
      "var ZL_CS_CFG = " +
      JSON.stringify({ ext: sr.id, js, css, runAt }) +
      ";\n" +
      BRIDGE_SOURCE;
    return new Response(body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (sr.kind === "cs") {
    /* #285: the path must be declared AND belong to an entry that
       matches the requesting virtual page; a non-matching site can
       neither fetch nor execute another site's content scripts. */
    if (!csFilesForPage(rec, ctx?.pageUrl).has(sr.path)) {
      /* Not declared for this page: it is not entitled to the file. */
      return notFound();
    }
    const bytes = await extensions.getResource(sr.id, sr.path, { fromWeb: false });
    return bytes ? assetResponse(bytes, sr.path) : notFound();
  }

  if (sr.kind === "pagejs") {
    /* #40: the extension-page bridge with the call list computed from
       the live permissions. Any same-origin page may load this file;
       it is inert without a registered page client (the SW refuses
       its zl:extPage messages). */
    /* #560: embed the resolved _locales so the page world can answer
       chrome.i18n synchronously (see pagebridge). */
    const i18n = await resolvePackageI18n(
      typeof rec.manifest.default_locale === "string" ? rec.manifest.default_locale : "",
      (p) => extensions.getResource(sr.id, p, { fromWeb: false }),
    );
    const body =
      "var ZL_PAGE_CFG = " +
      JSON.stringify({
        ext: sr.id,
        base: EXT_ROUTE + sr.id,
        /* #560: the manifest is embedded so the page bridge can
           answer runtime.getManifest synchronously (Chrome parity;
           extension pages read it during boot). */
        manifest: rec.manifest,
        calls: pageCallList(rec),
        ns: pageNamespaceList(rec),
        i18n: { locale: i18n.locale, messages: i18n.messages },
      }) +
      ";\n" +
      PAGE_BRIDGE_SOURCE;
    return new Response(body, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  /* #40: extension-origin pages. A navigation may skip the WAR gate
     only with a valid page token (minted by the host-only
     zl:openExtPage) or when the navigating client is already a page
     of this extension (self-navigation via runtime.getURL). A
     granted navigation registers the new client id so its
     subresources and zl:extPage messages authenticate. */
  const nav = ctx?.nav === true;
  const pageExt = pageClientOf(ctx?.clientId);
  if (nav && (checkPageToken(sr.id, sr.path, url.searchParams.get("zlPageTok") ?? "") || pageExt === sr.id)) {
    registerPageClient(ctx?.resultingClientId, sr.id);
    const own = await extensions.getResource(sr.id, sr.path, { fromWeb: false });
    if (!own) return notFound();
    return isHtmlPath(sr.path) ? htmlWithPageScript(own, sr.id) : assetResponse(own, sr.path);
  }
  if (!nav && pageExt === sr.id) {
    /* Subresource of a served extension page: full package access. */
    const own = await extensions.getResource(sr.id, sr.path, { fromWeb: false });
    return own ? assetResponse(own, sr.path) : notFound();
  }
  /* #504: a non-navigation fetch with a valid page token for exactly
     this (extension, path) serves one asset without the WAR gate.
     The host-only control plane mints icon URLs this way; the token
     binds to the single minted path on the same 5-minute TTL, so
     this grants exactly that resource and nothing else. */
  if (!nav) {
    const tok = url.searchParams.get("zlPageTok") ?? "";
    if (tok && checkPageToken(sr.id, sr.path, tok)) {
      const own = await extensions.getResource(sr.id, sr.path, { fromWeb: false });
      return own ? assetResponse(own, sr.path) : notFound();
    }
  }

  /* web_accessible_resources: WAR globs, MV3 "matches" scopes and
     #524 extension_ids are checked inside getResource against the
     SW-observed page destination and the registered page-client
     identity of the requester (#51; the old `from` query param was
     page-supplied and dead). A page client of another extension
     carries its identity here; unregistered pages carry none, and
     the gate then stays page-match-only. */
  const bytes = await extensions.getResource(sr.id, sr.path, {
    fromWeb: true,
    pageUrl: ctx?.pageUrl ?? null,
    fromExtensionId: pageClientOf(ctx?.clientId),
  });
  return bytes ? assetResponse(bytes, sr.path) : notFound();
}
