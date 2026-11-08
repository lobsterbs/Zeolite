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

/* #613: a Rust/WASM adblock engine (Brave's adblock-rust, crates/
   adblock) answers network and cosmetic queries in preference to
   the TS matcher when its CI-generated glue instantiated. Every
   gate here (the #381 fetch surface, the #500 sanity floor, the
   #577 idle kick, the retry cooldowns) applies to BOTH arms, and
   the TS matcher stays the fail-safe fallback body. */

import {
  FiltersEngine,
  Request as GhosteryRequest,
  type RequestType,
} from "@ghostery/adblocker";
import type { ResourceType } from "./rules";
import { initAdblockWasm, type AdblockWasmGlue, type WasmAdblockLike } from "./adblockwasm";
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
/* #551 second slice: the list origin is a build-time constant
   (vite define). The production default is the raw GitHub host; the
   deterministic cosmetic e2e build overrides it with a loopback
   fixture origin, which the fetch guard below then enforces for
   every list fetch. Declared locally so the only producer is
   vite.config.ts. */
declare const __ZL_LISTS_ORIGIN__: string;
const LISTS_ORIGIN = __ZL_LISTS_ORIGIN__;
const LISTS_PATH = "/ghostery/adblocker/master/packages/adblocker/assets/";

/* #613: the raw-list URL set for the Rust/WASM arm, mirroring the
   @ghostery/adblocker 2.20.1 adsAndTrackingLists the TS fallback
   downloads through this same guarded fetcher. Kept as a literal so
   the module never reaches into the dependency's dist internals;
   the ghostery-wasm-arm test pins set equality against the installed
   package, so a dependency bump that changes the set fails the
   suite instead of silently shipping a weaker engine. */
export const WASM_LIST_URLS: readonly string[] = [
  LISTS_ORIGIN + LISTS_PATH + "easylist/easylist.txt",
  LISTS_ORIGIN + LISTS_PATH + "peter-lowe/serverlist.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/badware.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/filters-2020.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/filters-2021.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/filters-2022.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/filters-2023.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/filters-2024.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/filters.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/quick-fixes.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/resource-abuse.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/unbreak.txt",
  LISTS_ORIGIN + LISTS_PATH + "easylist/easyprivacy.txt",
  LISTS_ORIGIN + LISTS_PATH + "ublock-origin/privacy.txt",
];

let fetchLists: typeof fetch | null = null;
let engine: FiltersEngine | null = null;
/* #613: the wasm arm engine; preferred over the TS engine above
   once installed. wasmDead pins a glue that is missing, older or
   failed to instantiate for this worker lifetime. */
let wasmEngine: WasmAdblockLike | null = null;
let wasmDead = false;
let loading: Promise<void> | null = null;
let retryAt = 0;
let refreshAt = 0
/* #551 second slice: one not-loaded scout note per worker
   lifetime, so a list origin that never delivers is visible in
   diagnostics instead of matching silently passing everything. */
let notLoadedReported = false;

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

async function fetchListsText(url: string): Promise<string> {
  const response = await fetchLists!(url);
  return response.text();
}

async function loadEngine(force = false): Promise<void> {
  if (loading || !fetchLists || ((engine || wasmEngine) && !force) || Date.now() < retryAt) {
    return loading ?? Promise.resolve();
  }
  loading = (async () => {
    try {
      let installed = false;
      /* #613: the Rust/WASM engine answers first when its glue
         initialized. It downloads the raw list set through the same
         guarded fetcher the TS matcher uses, so the #381 fetch
         surface never widens. A glue that is missing, older or
         failed to instantiate is sticky for this worker
         lifetime: one DIAG names the degradation and later loads
         skip straight to the TS arm. A failed list fetch or build
         is NOT sticky: that is transport or data, and the TS arm
         refetches immediately (one extra burst per failed
         attempt, backoff-capped by the retry cooldown below). */
      if (!wasmDead) {
        let glue: AdblockWasmGlue | undefined;
        try {
          glue = await initAdblockWasm();
        } catch (err) {
          wasmDead = true;
          DIAG.emit({
            requestId: DIAG.trace(),
            category: "TRANSPORT",
            cause: "proxy",
            severity: "info",
            stage: "UPSTREAM_RESPONSE",
            message:
              "adblock wasm arm unavailable (" +
              (err instanceof Error ? err.message : String(err)) +
              "); the TS matcher stays authoritative",
          });
        }
        if (glue) {
          try {
            const lists = await Promise.all(WASM_LIST_URLS.map(fetchListsText));
            const fresh = new glue.WasmAdblock(JSON.stringify(lists));
            const rules = fresh.input_rules();
            /* The #500 floor plus a canary probe: a junk or truncated
               body parses to a handful of rules and can never block
               the doubleclick canary, so either gate fails and the
               engine never installs. Not sticky: a later refresh
               can still draw a good body. */
            if (rules < MIN_NETWORK_FILTERS || !fresh.canary_blocks()) {
              DIAG.emit({
                requestId: DIAG.trace(),
                category: "TRANSPORT",
                cause: "proxy",
                severity: "warning",
                stage: "UPSTREAM_RESPONSE",
                message:
                  "adblock wasm engine parsed " + rules + " input rules from the filter lists (canary " +
                  (fresh.canary_blocks() ? "blocked" : "not blocked") +
                  "); empty or partial matcher, falling back to the TS matcher",
              });
            } else {
              wasmEngine = fresh;
              installed = true;
            }
          } catch (err) {
            DIAG.emit({
              requestId: DIAG.trace(),
              category: "TRANSPORT",
              cause: "proxy",
              severity: "warning",
              stage: "UPSTREAM_RESPONSE",
              message:
                "adblock wasm arm failed to build (" +
                (err instanceof Error ? err.message : String(err)) +
                "); falling back to the TS matcher",
            });
          }
        }
      }
      if (!installed) {
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
      }
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
    if (loading || !fetchLists || ((engine || wasmEngine) && !force) || Date.now() < retryAt) return;
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
      /* #551 second slice: the origin equality above already pins
         the port; this check compares against the configured
         origin's own port, so a loopback fixture origin WITH a port
         serves the deterministic cosmetic e2e while production
         (portless raw.githubusercontent.com) keeps refusing every
         ported URL exactly as before. */
      url.port !== new URL(LISTS_ORIGIN).port ||
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

/** The loaded Rust/WASM matcher, or null while pending or failed
    (#613). The cosmetic seam prefers it exactly like ghosteryBlock
    does, so network and cosmetic decisions always come from one
    loaded engine instance. */
export function wasmAdblockEngine(): WasmAdblockLike | null {
  return wasmEngine;
}

/** The wasm arm redirects to full data: URLs (its builtin resource
    set); the seam expects the same { body, contentType } shape as
    the TS arm's resource redirects, so the payload is decoded once
    at the boundary. An unparsable data URL drops the redirect and
    keeps the plain block. */
function dataUrlRedirect(dataUrl: string): GhosteryRedirect | null {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 6) return null;
  const parts = dataUrl.slice(5, comma).split(";");
  const payload = dataUrl.slice(comma + 1);
  try {
    const body = parts.includes("base64")
      ? atob(payload)
      : decodeURIComponent(payload);
    return { body, contentType: parts[0] || "text/plain" };
  } catch {
    return null;
  }
}

/** Return the matched block or redirect filter, or null when unmatched. */
export function ghosteryBlock(
  url: string,
  type: ResourceType,
  sourceUrl?: string,
  destination?: string,
): GhosteryDecision | null {
  if (!engine && !wasmEngine) {
    /* #551 second slice: the scout note above, emitted once per
       worker lifetime, never per request. */
    if (!notLoadedReported) {
      notLoadedReported = true;
      DIAG.emit({
        category: "TRANSPORT",
        cause: "proxy",
        severity: "info",
        stage: "UPSTREAM_REQUEST",
        message: "ghostery filter lists not loaded; adblock matching disabled until a list load succeeds",
        url,
      });
    }
    kickListLoad();
    return null;
  }
  if (Date.now() >= refreshAt) kickListLoad(true);
  if (wasmEngine) {
    /* #613 wasm arm: one JSON decision crosses the boundary per
       request. The TS arm matches no method at all, so the wasm arm
       pins "get" and $method-specific rules match in neither arm. */
    try {
      const raw = wasmEngine.check_network(url, sourceUrl ?? "", requestType(type, destination), "get");
      if (raw === null) return null;
      const dec = JSON.parse(raw) as { matched?: boolean; redirect?: string | null };
      if (!dec.matched) return null;
      const redirect = dec.redirect ? dataUrlRedirect(dec.redirect) : null;
      let host = "adblock wasm filter";
      try {
        host = new URL(url).hostname || host;
      } catch {
        /* keep the generic label */
      }
      return { host, ...(redirect ? { redirect } : {}) };
    } catch {
      return null;
    }
  }
  /* Narrowing only: reached with engine null solely when the wasm
     arm above returned, so this never fires in practice. */
  if (!engine) return null;
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
