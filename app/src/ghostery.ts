/* Ghostery's EasyList-compatible network filter engine. The matcher
   lives only in service-worker memory: proxied documents share the
   app origin today, so persisted matcher data would be writable by
   untrusted page scripts. List downloads use the engine's
   transport decision (wired by sw.ts through ghosteryListFetch,
   #381), never browser fetch.

   This adapter applies network block and resource-redirect
   decisions. #551 first slice: cosmetic CSS selectors for the
   document URL are computed from this engine by ./cosmetics and
   spliced into the document rewrite as a <style data-zl-cosmetic>
   (transform.ts init splice). Scriptlets and extended/HTML filters
   are counted and refused, never executed. */

import {
  FiltersEngine,
  Request as GhosteryRequest,
  type RequestType,
} from "@ghostery/adblocker";
import type { ResourceType } from "./rules";
import { DIAG } from "./diag";
import { loadInflight } from "./loadstate";
import { activeStreams, firstStreamSettled } from "./streams-alive";

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/* #500: sanity floor for a parsed ads+tracking engine. Any single
   real list parses to tens of thousands of network filters; a junk
   or truncated body parses to a handful. Below this the matcher
   counts as empty or partial and is never installed. */
const MIN_NETWORK_FILTERS = 1000;
const RETRY_AFTER_MS = 60 * 1000;
/* #577: an unreachable or hanging list origin must not burst its
   ~10 vendored fetches through the transport every minute. The
   cooldown grows 60s -> 4min -> 15min (cap) and resets on the first
   successful load. */
const RETRY_CAP_MS = 15 * 60 * 1000;
let retryDelay = RETRY_AFTER_MS;
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

/** Engine resource type mapping (#551 exports it so the cosmetic
    seam labels documents with the same vocabulary; getCosmeticsFilters
    itself is hostname-scoped and takes no request type). */
export function requestType(type: ResourceType, destination?: string): RequestType {
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
      const fresh = await FiltersEngine.fromPrebuiltAdsAndTracking(fetchLists!);
      /* #500: a list host can answer 200 with a junk or truncated
         body (captive portal, HTML error page) and the parser turns
         that into an engine with zero or a handful of network
         filters. No fetch failed, so the #381 load-failure row
         never fires, and the matcher runs with a near-zero block
         rate - the exact live symptom reported from relay-only
         deployments. The ads+tracking set parses to tens of
         thousands of network filters; anything under the sanity
         floor is junk, not a partial real load. One DIAG names the
         condition and junk never installs: the previously loaded
         good matcher survives, otherwise the matcher stays null. */
      const network = fresh.getFilters().networkFilters.length;
      if (network < MIN_NETWORK_FILTERS) {
        retryAt = Date.now() + retryDelay;
        refreshAt = retryAt;
        retryDelay = Math.min(retryDelay * 4, RETRY_CAP_MS);
        DIAG.emit({
          requestId: DIAG.trace(),
          category: "TRANSPORT",
          cause: "proxy",
          severity: "warning",
          stage: "UPSTREAM_RESPONSE",
          message:
            "ghostery filter lists parsed " + network + " network filters (empty or partial matcher); " +
            (engine ? "keeping the previously loaded rules" : "local rules stay active") +
            "; retrying after cooldown",
        });
        return;
      }
      engine = fresh;
      retryAt = 0;
      retryDelay = RETRY_AFTER_MS;
      refreshAt = Date.now() + REFRESH_AFTER_MS;
    } catch (err) {
      /* A temporarily unavailable list host must not break page
         requests. The existing local host list stays active and
         this worker retries after a short cooldown. #381: the
         failure is no longer silent - a TRANSPORT row names the
         load failure so relay-only transport gaps are visible. */
      retryAt = Date.now() + retryDelay;
      refreshAt = retryAt;
      retryDelay = Math.min(retryDelay * 4, RETRY_CAP_MS);
      DIAG.emit({
        requestId: DIAG.trace(),
        category: "TRANSPORT",
        cause: "proxy",
        severity: "warning",
        stage: "UPSTREAM_REQUEST",
        message:
          "ghostery filter-list load failed: " +
          (err instanceof Error ? err.message : String(err)) +
          "; local rules stay active",
      });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/* #577: the lazy list load shares the wisp transport singleton with
   page traffic, and the list origins are the one fetch class that
   can wedge for a whole first-byte deadline on filtered networks
   (the list host connects, then never answers). Started inline from
   the matching request, that wedge cost the triggering navigation
   its own deadline: the boot wedged through the reset/retry churn,
   the #477 ttfb seam turned it into a deterministic torture red, and
   CI flaked whenever the list origin was slow. The kick now defers
   to the first transport-idle gap: the loadstate counter reads zero once no upstream request is between its enter and its headers, and activeStreams (streams-alive) reads zero once no rewritten body is still pumping past its headers, so the download starts between page requests instead of racing the first one. Before any proxied body settles, every counter reads
   zero vacuously, so the gate also requires firstStreamSettled
   (streams-alive): the kick cannot fire in the boot window. The
   gate needs two consecutive quiet samples a poll apart, and a failed load backs off 60s -> 4min -> 15min so an unreachable list origin cannot keep churning the transport. ghosteryBlock keeps answering from the local rules
   (null) until the matcher exists, so no request ever waits on the
   download. */
const KICK_IDLE_POLL_MS = 250;
let kickTimer: ReturnType<typeof setTimeout> | null = null;

function kickListLoad(force = false): void {
  if (kickTimer !== null) return;
  let quiet = 0;
  const poll = () => {
    kickTimer = null;
    if (loading || !fetchLists || (engine && !force) || Date.now() < retryAt) return;
    if (!firstStreamSettled() || loadInflight() > 0 || activeStreams() > 0) {
      quiet = 0;
      kickTimer = setTimeout(poll, KICK_IDLE_POLL_MS);
      return;
    }
    /* #577: one quiet sample can land in the sub-millisecond gap
       between a rule match and its transport enter; two samples a
       poll interval apart cannot. */
    quiet += 1;
    if (quiet < 2) {
      kickTimer = setTimeout(poll, KICK_IDLE_POLL_MS);
      return;
    }
    void loadEngine(force);
  };
  kickTimer = setTimeout(poll, 0);
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

/** The loaded matcher, or null while the list load is pending/failed.
    #551: the cosmetic injection seam reads the same engine instance
    the network matcher answers from, so both arms agree on what is
    loaded; never a second parse. */
export function ghosteryEngine(): FiltersEngine | null {
  return engine;
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
    kickListLoad();
    return null;
  }
  if (Date.now() >= refreshAt) kickListLoad(true);
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
