/* Ghostery's EasyList-compatible network filter engine. The matcher
   lives only in service-worker memory: proxied documents share the
   app origin today, so persisted matcher data would be writable by
   untrusted page scripts. List downloads use the engine's Wisp
   transport (configured by sw.ts), never browser fetch.

   This adapter currently applies network block and resource-redirect
   decisions. Cosmetic selectors and scriptlets need a separate,
   CSP-aware document-rewrite integration and are deliberately not
   injected here. */

import {
  FiltersEngine,
  Request as GhosteryRequest,
  type RequestType,
} from "@ghostery/adblocker";
import type { ResourceType } from "./rules";

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 1000;
const LISTS_ORIGIN = "https://raw.githubusercontent.com";
const LISTS_PATH = "/ghostery/adblocker/master/packages/adblocker/assets/";

let fetchLists: typeof fetch | null = null;
let engine: FiltersEngine | null = null;
let loading: Promise<void> | null = null;
let retryAt = 0;
let refreshAt = 0;

export interface GhosteryRedirect {
  body: string;
  contentType: string;
}

export interface GhosteryDecision {
  host: string;
  redirect?: GhosteryRedirect;
}

function requestType(type: ResourceType, destination?: string): RequestType {
  if (destination === "iframe" || destination === "frame") return "sub_frame";
  if (destination === "document") return "document";
  if (destination === "object") return "object";
  if (destination === "audio" || destination === "video") return "media";
  switch (type) {
    case "document":
      return "document";
    case "script":
    case "worker":
    case "wasm":
      return "script";
    case "style":
      return "stylesheet";
    case "image":
      return "image";
    case "font":
      return "font";
    case "media":
      return "media";
    case "websocket":
      return "websocket";
    case "fetch":
      return "xmlhttprequest";
    case "eventsource":
      return "eventsource";
    case "manifest":
      return "manifest";
    default:
      return "other";
  }
}

async function loadEngine(force = false): Promise<void> {
  if (loading || !fetchLists || (engine && !force) || Date.now() < retryAt) {
    return loading ?? Promise.resolve();
  }
  loading = (async () => {
    try {
      engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetchLists!);
      retryAt = 0;
      refreshAt = Date.now() + REFRESH_AFTER_MS;
    } catch {
      /* A temporarily unavailable Wisp/list host must not break page
         requests. The existing local host list stays active and this
         worker retries after a short cooldown. */
      retryAt = Date.now() + RETRY_AFTER_MS;
      refreshAt = retryAt;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Set the list-fetch transport; matching starts lazily on first use.
    Ghostery's prebuilt list URLs are fixed, but keep this seam narrow:
    only its HTTPS asset directory is reachable and Wisp redirects are
    surfaced to this adapter instead of being followed to a new host. */
export function configureGhostery(fetcher: typeof fetch): void {
  fetchLists = async (input, init) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (
      url.origin !== LISTS_ORIGIN ||
      url.username ||
      url.password ||
      url.port ||
      !url.pathname.startsWith(LISTS_PATH) ||
      url.search ||
      url.hash ||
      method !== "GET"
    ) {
      throw new TypeError("Ghostery requested an unexpected filter-list URL");
    }
    const response = await fetcher(url.href, { ...init, method: "GET", redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Ghostery filter-list request did not return a success status");
    }
    return response;
  };
}

/** The request event uses this to keep a lazy filter-list load alive. */
export function ghosteryLoadInProgress(): Promise<void> | null {
  return loading;
}

/** Return the matched block or redirect filter, or null when unmatched. */
export function ghosteryBlock(
  url: string,
  type: ResourceType,
  sourceUrl?: string,
  destination?: string,
): GhosteryDecision | null {
  if (!engine) {
    void loadEngine();
    return null;
  }
  if (Date.now() >= refreshAt) void loadEngine(true);
  try {
    const result = engine.match(
      GhosteryRequest.fromRawDetails({
        url,
        sourceUrl: sourceUrl ?? "",
        type: requestType(type, destination),
      }),
    );
    if (!result.match) return null;
    return {
      host: result.filter?.getHostname() || "Ghostery network filter",
      ...(result.redirect
        ? { redirect: { body: result.redirect.body, contentType: result.redirect.contentType } }
        : {}),
    };
  } catch {
    return null;
  }
}
