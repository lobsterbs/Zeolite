/* Control plane: page + extension message dispatch.
 * Extracted from sw.ts (issues #85, #90, #91). Core zl: handling lives here;
 * extension-facing zl: messages are forwarded to ./extensions/control. */

import { buildNavHandleUrl, buildQueryHandleUrl, currentPrefix, decodeClientUrl, encodeDest, mintableDest, setScheme } from "./codec";
import type { JarConflictRule } from "./cookies";
import { documentCookieRead, documentCookieWrite, flushJarPersist, jarClear, jarClearScope, jarClientHasRoot, jarEnumeration, jarMerge, jarProfileState, jarReplace, jarSnapshot, inheritJarClient, markJarClientUnbound, registerJarNavHandle, setJarProfile, setSameSitePolicy } from "./cookies";
import { PAGE_MESSAGES, senderIsHostPage, senderIsProxiedPath } from "./cpgate";
import { buildDoctor, doctorKdl, observeDoctorBoot, probeDoctorAssets } from "./doctor";
import { primaryWispUrl } from "./config";
import { transportState } from "./transport-lifecycle";
import { policyDoctorState } from "./policy";
import { rulesDoctorState } from "./rules";
import { siteconfigDoctorState } from "./siteconfig";
import { DIAG } from "./diag";
/* #90: the download registry instance lives in ./downloads; the
   control plane lists and cancels entries through the subsystem. */
import { DL } from "./downloads";
import { EXT_CONTROL_TYPES, dispatchExtControl } from "./extensions/control";
import { pageClientOf } from "./extensions/serve";
import type { UiTab } from "./extensions/tabs";
import { TABS } from "./extensions/tabs";
import { netLogCursor, netLogGeneration, netLogSince } from "./netlog";
import { senderVirtualOrigin } from "./origin";
import type { RecordingState } from "./recording";
import { beginRecording, finishRecording } from "./recording";
import { pageCacheClear, virtualHcaptchaFrameFragment } from "./request";
import { setRulesEnabled, setSiteOverrides } from "./rules";
import { decryptSession, encryptSession } from "./session";
import { VCTX, ZEOLITE_VERSION, getEngineDegraded, getFpProfile, isHttpsUpgrade, isImageLazy, navHandlesEnabled, queryRoutesEnabled, registerDocCookiePort, setFingerprint, setHttpsUpgrade, setImageLazy, setNavHandles, setQueryRoutes, setReloadBypass, setSiteEnabled } from "./swstate";
import { setTracing, tracingSnapshot } from "./tracing";
import { transitStats } from "./transit";
import { relayAvailable, relayRegister } from "./relayfetch";
import { altConfigured, altRegister, currentEngine, engineReady, setPrimaryWisp, wispTransport } from "./transport";
import { loadInflight } from "./loadstate";
import { activeStreams } from "./streams-alive";
import { contextOf } from "./vctx";
import { wsBridge } from "./ws-runtime";
import type { PortLike } from "./wsbridge";
import { wsIdentityHeaders } from "./wsidentity";

declare const self: ServiceWorkerGlobalScope;

/* 1.9 Fullerene: active session recording, when any. */
let rec: RecordingState | null = null;

/* #180 (Injector phase 1): per-message bound for zl:decodeRoutes,
   the anchor read shim's decode oracle. */
const DECODE_ROUTES_MAX = 64;


/* ---- Control plane (Phase 2 + Phase 4) ---------------------------- */

export interface ControlMessage {
  type:
    | "zl:config"
    | "zl:reloadBypass"
    | "zl:mint"
    | "zl:decodeRoutes"
    | "zl:navHandle"
    | "zl:rules"
    | "zl:jarProfile"
    | "zl:siteRoute"
    | "zl:teardown"
    | "zl:ping"
    | "zl:getNetLog"
    | "zl:ext"
    | "zl:tabs"
    | "zl:menuClick"
    | "zl:listMenus"
    | "zl:notifyEvent"
    | "zl:extPage"
    | "zl:openExtPage"
    | "zl:listExt"
    | "zl:getDiag"
    | "zl:doctor"
    | "zl:installExt"
    | "zl:installExtFiles"
    | "zl:extEnable"
    | "zl:extInfo"
    | "zl:extUninstall"
    | "zl:adblock"
    | "zl:tracing"
    | "zl:getTracing"
    | "zl:wsOpen"
    | "zl:docCookie"
    | "zl:getVirtualOrigin"
    | "zl:embedderOrigin"
    | "zl:getEmbedder"
    | "zl:downloads"
    | "zl:cancelDownload"
    | "zl:pauseDownload"
    | "zl:resumeDownload"
    | "zl:saveDownload"
    | "zl:downloadState"
    | "zl:exportSession"
    | "zl:importSession"
    | "zl:sameSite"
    | "zl:relayRegister"
    | "zl:wispRegister"
    | "zl:wispPrimary"
    | "zl:fingerprint"
    | "zl:recordStart"
    | "zl:recordStop"
    | "zl:find"
    | "zl:getJars"
    | "zl:clearJar"
    | "zl:transport"
  | "zl:loadState";
  /** Doctor: the host supplies version/scope expectations; no guessed values. */
  expectedScope?: string;
  expectedVersion?: string;
  /** Opt-in, same-origin HEAD probes for static bundle assets only. */
  probeAssets?: boolean;
  /** Return parseable versioned KDL in addition to typed check data. */
  format?: "kdl";
  extId?: string;
  msg?: unknown;
  prefix?: string;
  /** zl:config route scheme. Fixed "b64u" since #32; any other value
      is rejected (mirror removed). Kept optional for old embedders. */
  scheme?: string;
  /** zl:config: opt-in engine-side HTTPS upgrade (#53). Absent keeps
      the persisted choice; the ack echoes the live value. */
  httpsUpgrade?: boolean;
  /** zl:config: opt-in lazy images; absent keeps the live choice. */
  imageLazy?: boolean;
  /** zl:config: opt-in refusal of the plaintext ?url= initial
      navigation (#63). Absent keeps the persisted choice (legacy
      ?url= accepted, the migration window); the ack echoes the live
      value. Hosts that navigate via zl:navHandle set this so no
      plaintext embed can appear on the deployment afterwards. */
  navHandles?: boolean;
  /** zl:config: opt-in query-shape committed routes (Injector phase
      2; the committed URL keeps the real path and query, the opaque
      token rides ?zlNavh=). Ephemeral like navHandles: a worker
      restart reverts it, the host re-pushes on boot. */
  queryRoutes?: boolean;
  /** zl:transport: engine selection (#64). Absent = a poll; the reply carries the live engine; "libcurl"|"epoxy" switches it on the next init(). */
  engine?: "libcurl" | "epoxy";
  /** zl:rules: default outgoing user-agent for hosts without an
      override (null/absent keeps the browser's own UA). */
  ua?: string | null;
  /** zl:rules: host-app per-site overrides, longest host suffix wins. */
  rules?: Array<{ host: string; adblock?: boolean; ua?: string | null }>;
  site?: string;
  enabled?: boolean;
  /** UI -> SW authoritative tab sync payload. */
  tabs?: UiTab[];
  /** Delta sync cursor for zl:getNetLog. */
  since?: number;
  /** Host-only diagnostic scope. */
  clientId?: string;
  /** zl:wsOpen: page WebSocket bridge destination + protocols. */
  url?: string;
  protocols?: string[];
  /** zl:docCookie / zl:wsOpen origin claim from the page. Bug-scout
      fix: the handlers never trust this field; any proxied page
      could claim another site's origin and reach its jar cookies or
      forge the WS handshake identity. The sender's own client
      route is the only source. Documents what pages still send. */
  origin?: string;
  set?: string;
  /** zl:cancelDownload: registry entry id. */
  id?: string;
  /** zl:exportSession / zl:importSession: blob passphrase. */
  passphrase?: string;
  /** zl:importSession: the encrypted session blob. */
  blob?: unknown;
  /** zl:importSession: "replace" (default) or "merge" (2.2 Arsenide). */
  mode?: "replace" | "merge";
  /** zl:importSession merge conflict rule. */
  rule?: string;
  /** zl:sameSite: jar SameSite policy knob ("off" | "approx"). */
  policy?: unknown;
  /** zl:exportSession: caller-supplied payload, encrypted whole. */
  extra?: unknown;
  /** zl:fingerprint: profile object, or null to return to native. */
  profile?: unknown;
  /** zl:recordStart: caller-supplied recording id. */
  recId?: string;
  /** zl:installExt: packaged (.xpi/.zip) bytes. */
  bytes?: Uint8Array;
  /** zl:installExtFiles: unpacked directory listing, path -> bytes. */
  files?: Array<[string, Uint8Array]>;
  /** zl:find (#29): destination of the addressed page, matched
      SW-side against the client whose route decodes to it. The
      findLoad message posted to the page carries no destination
      (#32: no page-visible surface echoes the target). */
  dest?: string;
  /** zl:find command: search, step or clear. */
  cmd?: "find" | "next" | "prev" | "clear";
  /** zl:find search pattern (cmd "find"). */
  pattern?: string;
  /** zl:find options: caseSensitive, wholeWord and wrap (default
      true), passed through to the page-side finder. */
  options?: { caseSensitive?: boolean; wholeWord?: boolean; wrap?: boolean };
  /** zl:decodeRoutes (#180): route strings from the page's own
      markup; the reply's dests array parallels it. */
  routes?: unknown[];
}

/* #29 (zl:find): the compiled page-side finder ships to the page
   inside the findLoad message. The bundle is a sibling artifact of
   this worker (finder.js, built from src/finder.ts), fetched once
   per SW instance - worker-own fetches never re-enter this fetch
   handler - and cached in the closure. An unavailable bundle answers
   the find command honestly instead of pretending. */
let finderSource: Promise<string | null> | null = null;
/* #377: last profile and UA the host sent; a change clears the page cache. */
let lastFingerprintKey: string | null = null;
let lastRulesUa: unknown = undefined;
function loadFinderSource(): Promise<string | null> {
  finderSource ??= fetch(new URL("finder.js", self.location.href))
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  return finderSource;
}

/* Bug-scout fix: control-plane messages used to trust msg.origin, so
   any proxied page could claim another site's origin; jar cookie
   reads and writes via zl:docCookie, a forged per-origin WS handshake
   identity via zl:wsOpen. The sender's real origin is recovered from
   its own client route instead; the claim is never read. Unknown or
   non-proxied senders fail closed (null). */
function senderOrigin(e: ExtendableMessageEvent): string | null {
  const client = e.source;
  if (client && "url" in client) {
    return senderVirtualOrigin(client.url, self.location.origin);
  }
  return null;
}

/* #35 (browser E2E): docCookie port registry. The page's synchronous
   document.cookie getter serves an optimistic copy refreshed over the
   zl:docCookie port; a Set-Cookie admitted on a proxied fetch/XHR
   response used to stay invisible until the page's next read. The
   fetch path pushes the fresh jar view over the same port right after
   admission. Keyed by client id; capped so a page that keeps
   re-opening docCookie channels cannot grow the map without bound
   (the oldest entry is dropped, its port simply stops receiving
   pushes - reads still refresh on demand). */
/* #41: jar control is host-only. Proxied pages are SW clients too,
   and zl:getJars must never hand one target site every other site's
   cookies: the sender must be a host page (adapter, devtools), not a
   proxied route or nav marker. #48: extension-origin pages are
   extension code, not host pages, so they are untrusted here too. */
function senderIsProxiedPage(e: ExtendableMessageEvent): boolean {
  /* #170: fail closed onto the host-page allowlist: an unparseable,
     cross-origin, opaque or unknown-path sender is never a host
     page, so it gets the proxied-page refusal. */
  const src = e.source as Client | null;
  if (!src || !src.url) return true;
  return !senderIsHostPage(src.url, self.location.origin);
}

/* Page-facing control messages and the pathname half of the sender
   gate live in cpgate.ts (extracted for #63 so vitest can pin them). */


export interface ControlDeps {
  ready: Promise<unknown>;
  persistRoute: (...args: any[]) => any;
}

export interface CoreCtx {
  e: ExtendableMessageEvent;
  reply: (data: any) => void;
  port: any;
  persistRoute: (...args: any[]) => any;
}

/* #107 phase 2 (LobsterBrowse split-origin): the embedder origin the
   boot page registered via the zlRegAsk handshake. Memory-only, like
   the relay ports: a worker restart drops it and the boot page
   re-registers on its zl:relayLost heal. zl:embedderOrigin is
   host-only by the #41 gate (not in PAGE_MESSAGES), so no proxied
   page can set it. */
let embedderOrigin = "";

export async function dispatchCore(msg: ControlMessage, ctx: CoreCtx): Promise<void> {
  const { e, reply, port, persistRoute } = ctx;
  const sourceClient = e.source as Client | null;
  const sourceClientId = sourceClient?.id;
  if (sourceClient?.id && sourceClient.url && !jarClientHasRoot(sourceClient.id)) {
    inheritJarClient(sourceClient.id, undefined, sourceClient.url);
    try {
      const sourceUrl = new URL(sourceClient.url);
      if (
        sourceUrl.origin === self.location.origin &&
        senderIsProxiedPath(sourceUrl.pathname, sourceUrl.search) &&
        !jarClientHasRoot(sourceClient.id)
      ) markJarClientUnbound(sourceClient.id);
    } catch {
      /* An opaque/unparseable message source has no recoverable jar. */
    }
  }
  switch (msg?.type) {
    /* Doctor is handled BEFORE boot gating and jar inheritance in
       handleControlEvent. This case is a fail-closed registry guard. */
    case "zl:doctor":
      reply({ ok: false, error: "doctor must use the host-only preflight" });
      break;
    case "zl:relayRegister": {
      /* #137: the embedder registers its relay port. Host-only by the
         #41 gate (not in PAGE_MESSAGES); the port carries policy-
         relayed fetches: zl:fetchRelay out, head/chunk/end/error
         frames back. The ok reply rides the same port, so the
         embedder's handler must tolerate non-relay frames. */
      const rp = e.ports[0];
      if (rp) {
        relayRegister(rp, (msg as unknown as { credits?: unknown }).credits);
        reply({ ok: true });
      } else {
        reply({ ok: false, error: "relay registration needs a port" });
      }
      break;
    }
    case "zl:wispPrimary": {
      /* LobsterBrowse Settings: the active WISP server carries all
         traffic. "" restores the build-time endpoint. Persisted with
         the route shape so a restarted worker keeps the choice. */
      if (typeof msg.url === "string" && setPrimaryWisp(msg.url)) {
        void persistRoute(currentPrefix());
        reply({ ok: true });
      } else {
        reply({ ok: false, error: "primary wisp needs a ws(s):// url or an empty string" });
      }
      break;
    }
    case "zl:wispRegister": {
      /* #168: the embedder announces the PUBLIC wisp endpoint for
         policy route "wisp" hosts (LB serves it as /build sjWisp;
         its own /wisp/ keeps password auth). Host-only by the #41
         gate; an empty string withdraws the endpoint. */
      if (typeof msg.url === "string" && (msg.url === "" || msg.url.startsWith("ws://") || msg.url.startsWith("wss://"))) {
        altRegister(msg.url);
        /* 2026-10-15: persist with the route shape so an idle-killed
           worker instance restores the endpoint without waiting for a
           re-announce that never comes (controllerchange does not
           fire on an instance restart). */
        void persistRoute(currentPrefix());
        reply({ ok: true });
      } else {
        reply({ ok: false, error: "wisp registration needs a ws(s):// url or an empty string" });
      }
      break;
    }
    case "zl:ping":
      /* Issue #17: echo the live route shape so embedders can detect a
         revert to defaults (worker restart, storage wipe) and re-push
         their config. */
      reply({
        ok: true,
        version: ZEOLITE_VERSION,
        degraded: getEngineDegraded(),
        prefix: currentPrefix(),
        /* Fixed shape since #32 (mirror removed); kept in the reply so
           old embedder probes that compare it stay compatible. */
        scheme: "b64u",
        httpsUpgrade: isHttpsUpgrade(),
        /* Lazy images: parity with the zl:config ack, so an embedder
           (the LB debug readout) reads the live choice from ping. */
        imageLazy: isImageLazy(),
        /* #63: the live ?url= refusal choice, so an embedder detects a
           revert to defaults and re-pushes its config. */
        navHandles: navHandlesEnabled(),
        /* Injector phase 2: the live query-shape opt-in. */
        queryRoutes: queryRoutesEnabled(),
        profile: jarProfileState((e.source as { id?: string } | null)?.id),
      });
      break;
    case "zl:config": {
      // Rotate the URL shape at runtime.
      /* Issue #32: the mirror scheme is gone (it placed the real
         destination inside every browser-visible route string);
         a non-default scheme is rejected so an embedder learns
         immediately instead of silently degrading. */
      if (typeof msg.scheme === "string" && msg.scheme !== "b64u") {
        reply({ ok: false, error: "scheme removed: routes are b64u only (#32)" });
        break;
      }
      /* #53: absent leaves the persisted choice (old embedders). */
      if (typeof msg.httpsUpgrade === "boolean") setHttpsUpgrade(msg.httpsUpgrade);
      /* Lazy images: same rule - absent keeps the live choice. */
      if (typeof msg.imageLazy === "boolean") setImageLazy(msg.imageLazy);
      /* #63: same migration-window rule for the ?url= refusal. */
      if (typeof msg.navHandles === "boolean") setNavHandles(msg.navHandles);
      /* Injector phase 2: same rule for the query-shape routes. */
      if (typeof msg.queryRoutes === "boolean") setQueryRoutes(msg.queryRoutes);
      setScheme(msg.prefix ?? "/j/");
      /* Issue #17: persist so a worker restart keeps the shape. */
      void persistRoute(currentPrefix());
      reply({ ok: true, prefix: currentPrefix(), scheme: "b64u", httpsUpgrade: isHttpsUpgrade(), imageLazy: isImageLazy(), navHandles: navHandlesEnabled(), queryRoutes: queryRoutesEnabled() });
      break;
    }
    case "zl:reloadBypass":
      /* #211 (LobsterBrowse): arm the one-shot page-cache bypass for
         the next document GET (Reload and bypass cache). */
      setReloadBypass(true);
      reply({ ok: true });
      break;
    case "zl:mint": {
      /* #55/#54: mint an opaque route for a destination. The reply
         carries the route only, never the key: the key must not
         leave the worker realm. #54 residual 1 admits proxied
         pages to this case: a page can already construct a legacy
         route for any destination (the codec is page-public), so
         minting grants no new capability; mints are bounded to
         absolute http(s) destinations (mintableDest). With no key
         active (storage unavailable) this still answers, with a
         legacy route: the degraded mode, not an error. */
      if (typeof msg.dest !== "string" || !mintableDest(msg.dest)) {
        reply({ ok: false, error: "mint needs an absolute http(s) dest" });
        break;
      }
      /* The browser strips fragments before fetch interception, but
         the mint message still carries them. Source identity comes
         only from the browser-owned client/context, never msg.origin. */
      const sourceId = e.source && "id" in e.source ? e.source.id : undefined;
      const home = contextOf(VCTX, sourceId)?.targetOrigin ?? senderOrigin(e) ?? undefined;
      const dest = virtualHcaptchaFrameFragment(msg.dest, self.location.origin, home);
      /* Fragments belong to the browser, never the encoded network
         target. Otherwise the worker strips the decoded fragment
         before fetch and the document can never observe it. */
      const hash = dest.indexOf("#");
      const route = hash < 0 ? encodeDest(dest) : encodeDest(dest.slice(0, hash)) + dest.slice(hash);
      reply({ ok: true, route });
      break;
    }
    case "zl:decodeRoutes": {
      /* #180 (Injector phase 1): the anchor read shim's decode
         oracle. Keyed route tokens are undecodable in the page
         realm (the key never leaves the worker), so a read of a
         rewriter-minted anchor asks the worker to decode routes the
         page's own markup already carries; Startpage-style pages
         derive their visible breadcrumb from the anchor href, so
         without this the opaque route URL leaked onto the page
         surface. Admitted to proxied pages like zl:mint (the
         destinations are the page's own markup data); bounded per
         message (DECODE_ROUTES_MAX routes, 2048 chars each) so it
         cannot become a bulk oracle; garbage and foreign tokens
         decode to null and the caller keeps its native value. */
      const routes = Array.isArray(msg.routes) ? msg.routes.slice(0, DECODE_ROUTES_MAX) : [];
      const dests = routes.map((v: unknown): string | null => {
        if (typeof v !== "string" || v.length > 2048) return null;
        try {
          return decodeClientUrl(new URL(v, self.location.origin));
        } catch {
          return null;
        }
      });
      try { reply({ ok: true, dests }); }
      finally { port?.close(); }
      break;
    }
    case "zl:navHandle": {
      /* #63 (#54 design D): mint the opaque initial-navigation
         handle. Host-only by the #41 gate: zl:navHandle is not in
         PAGE_MESSAGES, so a proxied-page sender is refused above
         before this case ever runs - a page must not be able to mint
         initial-navigation handles for arbitrary destinations. The
         handle is a keyed token with a short TTL, stateless by
         construction: nothing is persisted, so it survives a SW
         restart (decode walks the route-key history the same way
         routes do). Without a route key (storage unavailable) this
         refuses instead of answering a legacy-shape handle, which
         would carry the destination decodably - exactly the leak
         the handle exists to stop. */
      if (typeof msg.dest !== "string" || !mintableDest(msg.dest)) {
        reply({ ok: false, error: "navHandle needs an absolute http(s) dest" });
        break;
      }
      /* #144: the handle URL is NAVH + "/" + <origin-only token> +
         <real path> + <real query>. The path is visible by design so
         pathname-routed SPAs can route; the host stays opaque to the
         browser, history and extensions (decision recorded in
         docs/security.md). */
      /* Injector phase 2: with queryRoutes on, the committed handle
         rides the query string (<real path>?<real query>&zlNavh=
         <token>), so location.pathname reads the real path natively -
         the LegacyUnforgeable class no shim can fix. A mint-refused
         collision (an engine-internal path) falls back to the NAVH
         form so the host keeps a usable handle. */
      const url = queryRoutesEnabled()
        ? buildQueryHandleUrl(msg.dest, undefined, sourceClientId) ??
          buildNavHandleUrl(msg.dest, undefined, sourceClientId)
        : buildNavHandleUrl(msg.dest, undefined, sourceClientId);
      if (url === null) {
        reply({ ok: false, error: "navHandle unavailable: no route key (storage degraded); keep the legacy ?url= embed" });
        break;
      }
      registerJarNavHandle(url, sourceClientId);
      reply({ ok: true, url });
      break;
    }
    case "zl:adblock":
      /* Host toggle for the local rules and Ghostery network matcher.
         Decisions become no-ops while disabled. Resets to enabled on
         SW restart. */
      setRulesEnabled(msg.enabled !== false);
      reply({ ok: true });
      break;
    case "zl:rules":
      /* Host-app per-site rules (the rules chip / per-site settings):
         a host-scoped adblock override plus UA strings, evaluated per
         request against the target host (rules.ts). Ephemeral like
         zl:adblock: resets on SW restart, the host re-sends on boot. */
      /* #377: a UA change alters what upstream sends; drop the cache. */
      if (msg.ua !== lastRulesUa) {
        lastRulesUa = msg.ua;
        void pageCacheClear();
      }
      reply({ ok: true, count: setSiteOverrides(msg.rules, msg.ua) });
      break;
    case "zl:jarProfile":
      /* Host-app jar identity (incognito): switch the whole cookie
         jar between the durable default profile and a throwaway
         session profile. Session cookies never touch IndexedDB and
         are dropped on the switch back (cookies.ts). Resets to
         default on SW restart; the host re-sends on boot, on the
         incognito toggle, and on controllerchange. */
      reply(setJarProfile(msg.profile, (e.source as { id?: string } | null)?.id));
      /* #179: the page cache spans jar profiles; a profile switch
         drops it so one profile's cached pages never surface for
         another. */
      void pageCacheClear();
      break;
    case "zl:getJars":
      /* #41: jar enumeration for the host (the host settings UI
         renders and manages cookie-jar state). Host-only: the
         proxied-sender gate above refuses target-site pages. */
      /* #267: the enumeration and the active flag are the requesting
         client's own, not the legacy global. */
      const jarViews = jarEnumeration((e.source as { id?: string } | null)?.id);
      reply({ ok: true, active: jarViews.find((p) => p.active)?.profile ?? jarProfileState(), profiles: jarViews });
      break;
    case "zl:clearJar": {
      /* #41: clear the active (or named) jar profile, or one origin
         inside it. Refuses malformed input instead of coercing. */
      const r = jarClearScope(msg.profile, msg.origin, (e.source as { id?: string } | null)?.id);
      /* #179: a cleared jar means the cached pages may be another
         session's; drop the page cache with it. */
      if (r.ok) void pageCacheClear();
      e.waitUntil(
        (async () => {
          /* #254: durable before the ack, so a worker death between
             the clear and the write cannot resurrect the cookies. */
          await flushJarPersist();
          reply(r.ok ? { ok: true, jars: r.jars, cookies: r.cookies } : { ok: false, error: r.error });
        })(),
      );
      break;
    }
        case "zl:transport": {
      /* #64: host-side engine selection (the DevTools toggle).
         No engine = a poll (devtools keeps its select in
         sync, the same pattern as the tracing toggle); an
         invalid engine refuses honestly; a valid one
         switches the transport for the NEXT init(): the
         running client keeps its engine until the service
         worker restarts, and the switchEngine seam forces the
         re-init on the next request. #390: the choice persists in
         the Cache API and survives an idle worker restart
         (controllerchange never fires for one, so the embedder
         cannot re-send it); tracing stays ephemeral. */
      const eng = (msg as { engine?: unknown }).engine;
      if (eng === undefined) {
        await engineReady(); // #390: answer the restored choice, not the pre-restore default
        reply({ ok: true, engine: currentEngine() });
      } else if (eng !== "libcurl" && eng !== "epoxy") {
        reply({ ok: false, error: "transport needs engine libcurl|epoxy" });
      } else {
        wispTransport.switchEngine(eng);
        reply({ ok: true, engine: currentEngine() });
      }
      break;
    }
case "zl:loadState": {
  /* Host-only loading-indicator query: how many upstream requests
     for a destination host (absent host = the global sum) are
     still in flight, plus the rewrite streams currently pumping.
     TTFB semantics: a request counts until its headers arrive or
     it fails; document bodies rewriting past TTFB are the
     streams number. Refused for proxied-page senders by the gate
     above: the counts must not enumerate other sites. */
  const host = typeof (msg as { host?: unknown }).host === "string" ? (msg as { host?: string }).host : undefined;
  reply({ ok: true, inflight: loadInflight(host || undefined), streams: activeStreams() });
  break;
}
case "zl:tracing":
      /* 1.2 Halide: opt-in rewrite tracing ring. Off by default;
         resets to off on SW restart, so the host re-sends it. */
      setTracing(msg.enabled !== false);
      reply({ ok: true, enabled: msg.enabled !== false });
      break;
    case "zl:getTracing": {
      /* Delta poll, same cursor protocol as zl:getNetLog, generation
         included so a devtools that reconnected across a worker
         restart resets its tracing cursor like the netLog one. */
      const since = (msg as { since?: number }).since ?? 0;
      reply({ ok: true, generation: netLogGeneration(), ...tracingSnapshot(since) });
      break;
    }
    case "zl:siteRoute":
      if (!msg.site) {
        reply({ ok: false, error: "missing site" });
        break;
      }
      setSiteEnabled(msg.site, msg.enabled !== false);
      reply({ ok: true });
      break;
    case "zl:wsOpen": {
      /* 1.3 Carbide: the port IS the connection: events flow back on
         it, send/close flow forward on it. */
      if (!port || typeof msg.url !== "string" || !/^wss?:/i.test(msg.url)) {
        port?.postMessage({ ev: "error", error: "bad zl:wsOpen" });
        port?.postMessage({ ev: "close", code: 1006, clean: false });
        port?.close();
        break;
      }
      /* Issue #4: an all-cached page can open a WebSocket before any
         proxied fetch initialized the transport; openWebSocket would
         throw on the uninitialized client and every bridge ws closed
         1006. Wait for the transport here (sends queue at the bridge
         until the handshake completes). */
      try {
        await wispTransport.ready();
      } catch {
        port.postMessage({ ev: "error", error: "transport unavailable" });
        port.postMessage({ ev: "close", code: 1006, clean: false });
        port.close();
        break;
      }
      /* Deep-integration item 4: per-origin virtual WS identities. The
         handshake carries the initiator's virtual origin, the jar's
         cookies for the target and the per-site UA (an active
         fingerprint profile still wins), instead of the single
         bridge identity every proxied site used to share. The origin
         is an explicit message field when the sender knows it, else
         recovered from the controlling client's route - the same
         initiator recovery the fetch path uses (works for
         worker-relayed sockets too, since the relay runs in the page
         context). Headers are engine-built only: a page can never
         smuggle handshake headers onto the transport. */
      /* Bug-scout fix: msg.origin was a spoof vector (any proxied
         page could forge the per-origin handshake identity). The
         sender's own client route is the only source; worker-relayed
         sockets resolve to their page the same way. Unknown sender
         means no Origin header, honest absence. */
      let wsOrigin: string | null = senderOrigin(e);
      /* Issue #32: the page shim no longer retargets same-origin ws
         URLs (it never sees the real origin). An engine-origin ws URL
         carries no destination: the sender's own virtual context
         (#33) supplies the target; the sender's client route decodes
         as the restart fallback; an unknown sender fails closed.
         Cross-origin URLs pass through: the page named that host
         itself. Worker-relayed sockets arrive via their page's relay,
         so they resolve against the page context, same as before. */
      let wsUrl = msg.url;
      try {
        const u = new URL(msg.url);
        /* #279: engine-local ws URLs arrive with the ws/wss scheme
           and u.origin carries it, so it can never equal the
           worker https origin - the engine-local test is host
           equality. */
        if (u.host === self.location.host) {
          let home = contextOf(VCTX, (e.source as { id?: string } | null)?.id)?.targetOrigin ?? null;
          if (!home) {
            const client = e.source;
            const cu = client && "url" in client ? decodeClientUrl(new URL((client as { url: string }).url, self.location.origin)) : null;
            home = cu ? new URL(cu).origin : null;
          }
          if (!home) {
            port.postMessage({ ev: "error", error: "unknown ws context" });
            port.postMessage({ ev: "close", code: 1006, clean: false });
            port.close();
            break;
          }
          /* #279: a handle (NAVH) ws route carries the real path
             visibly and a routed ws literal decodes to its true
             destination, so the full client decode resolves the
             path exactly; everything else keeps the origin-level
             retarget (root-relative paths, opaque legacy tails). */
          const full = decodeClientUrl(u);
          const t = new URL(full ?? u.pathname + u.search, home);
          t.protocol = u.protocol;
          wsUrl = t.href;
        }
      } catch {
        /* unparseable URL: the wss?: validation already answered */
      }
      const wsHeaders = wsIdentityHeaders(wsOrigin, wsUrl, {
        profile: getFpProfile(),
        clientId: sourceClientId,
      });
      wsBridge.open(port as unknown as PortLike, wsUrl, Array.isArray(msg.protocols) ? msg.protocols : [], wsHeaders);
      break;
    }
    case "zl:docCookie": {
      /* 1.6 Hydride: single-channel document.cookie sync. The port
         is transferred once and kept; the initial message and every
         follow-up on the port is answered with the authoritative jar
         view, so the page-side cache stays eventually consistent
         without a fresh MessageChannel per read/write. */
      /* Bug-scout fix: msg.origin was a spoof vector; any proxied
         page could read or write another site's jar cookies by
         claiming its origin. The sender's own client route decides
         the jar; the claim is never read. */
      const origin = senderOrigin(e);
      if (!port || !origin) {
        reply({ ok: false, error: "bad zl:docCookie" });
        break;
      }
      const handle = (set?: unknown) => {
        /* #267: the port's own client scopes the jar view. */
        const cid = (e.source as { id?: string } | null)?.id;
        if (typeof set === "string") documentCookieWrite(origin, set, cid);
        port.postMessage({ ok: true, cookie: documentCookieRead(origin, cid) });
      };
      handle(msg.set);
      port.onmessage = (ev: MessageEvent) => handle((ev.data as { set?: unknown }).set);
      /* #35: keep the port so the fetch path can push jar updates
         (Set-Cookie on a proxied response) into this client's
         optimistic document.cookie copy. Same origin-trust rule as the
         reads above: the jar was fixed by senderOrigin, the page can
         claim nothing. */
      const cid = (e.source as { id?: string } | null)?.id;
      if (cid) registerDocCookiePort(cid, port, origin);
      break;
    }
    case "zl:getVirtualOrigin": {
      /* #130: this client's own virtual origin, recovered from the
         sender's engine route (never a page-supplied claim). The page
         marks its window so recipient frames can label engine-delivered
         messages with the sender's virtual origin. Undecodable senders
         fail closed (null: no marker installed). */
      reply({ ok: true, vo: senderOrigin(e) });
      break;
    }
    case "zl:embedderOrigin": {
      /* #107 phase 2: the boot page reports the app origin embedding
         the engine. The stored value is only ever a postMessage
         targetOrigin, so a forged registration sends nothing to any
         window not already resident at the claimed origin. */
      const o = typeof msg.origin === "string" ? msg.origin : "";
      if (/^https:\/\/[^/]+$/.test(o)) {
        embedderOrigin = o;
        reply({ ok: true });
      } else {
        reply({ ok: false, error: "bad zl:embedderOrigin" });
      }
      break;
    }
    case "zl:getEmbedder": {
      /* #107 phase 2: an embedded proxied frame asks who embedded
         it. url is THIS client's own virtual URL decoded worker-side
         from its route (never a page claim); origin is the
         registered embedder or null (fail closed). Page-facing by
         design: the payload names only the sender's own state and
         the public embedder origin. */
      let url: string | null = null;
      const src = e.source as Client | null;
      if (src && src.url) {
        try {
          url = decodeClientUrl(new URL(src.url, self.location.origin));
        } catch {
          url = null;
        }
      }
      reply({ ok: true, origin: embedderOrigin || null, url, clientId: src?.id ?? null });
      break;
    }
    case "zl:fingerprint":
      /* 1.8 Telluride: resolve + compile the profile, or drop back to
         fully native surfaces. */
      /* #377: the cache key is the URL alone, so a persona or UA change
         must drop what was stored under the old one. */
      {
        const fpKey = JSON.stringify(msg.profile ?? null);
        if (fpKey !== lastFingerprintKey) {
          lastFingerprintKey = fpKey;
          void pageCacheClear();
        }
      }
      reply(setFingerprint(msg.profile ?? null));
      break;
    case "zl:recordStart": {
      /* 1.9 Fullerene: deterministic session recording. Forcing the
         tracing ring on is a recording side effect, not a silent
         surveillance default: recording is always explicit. */
      if (rec) {
        reply({ ok: false, error: "recording already active: " + rec.id });
        break;
      }
      const snap = tracingSnapshot(0);
      rec = beginRecording({
        id: msg.recId,
        now: Date.now(),
        netCursor: netLogCursor(),
        traceCursor: snap.lastSeq,
        tracingWasEnabled: snap.enabled,
      });
      setTracing(true);
      reply({ ok: true, record: { id: rec.id, startedAt: rec.startedAt } });
      break;
    }
    case "zl:recordStop": {
      if (!rec) {
        reply({ ok: false, error: "no recording active" });
        break;
      }
      const r = rec;
      rec = null;
      const record = finishRecording(r, {
        now: Date.now(),
        engine: ZEOLITE_VERSION,
        netEntries: netLogSince(r.netCursor),
        traceEntries: tracingSnapshot(r.traceCursor).entries,
        cookieJar: [...jarSnapshot()],
      });
      setTracing(r.tracingWasEnabled);
      reply({ ok: true, record });
      break;
    }
    case "zl:find": {
      /* #29: in-page find. The SW cannot touch page DOM, so the
         command is forwarded to the page whose client route decodes
         to msg.dest exactly (addressing is fully SW-side; the
         findLoad message itself carries no destination, #32); that
         page runs the compiled finder, whose
         source is attached to the message and evaluated once per
         document by the bootstrap loader. Replies flow back on the
         transferred port; a page that never answers - no proxied
         document at dest, or one without the bootstrap - fails
         honestly on the timeout instead of hanging the find bar. */
      if (
        !port ||
        typeof msg.dest !== "string" ||
        (msg.cmd !== "find" && msg.cmd !== "next" && msg.cmd !== "prev" && msg.cmd !== "clear") ||
        (msg.cmd === "find" && typeof msg.pattern !== "string")
      ) {
        reply({ ok: false, error: "bad zl:find" });
        break;
      }
      e.waitUntil(
        (async () => {
          const code = await loadFinderSource();
          if (code === null) {
            reply({ ok: false, error: "finder bundle unavailable" });
            return;
          }
          const mc = new MessageChannel();
          let done = false;
          let timer: ReturnType<typeof setTimeout>;
          const finish = (payload: {
            ok: boolean;
            error?: string;
            matches?: number;
            ordinal?: number;
            highlight?: string;
          }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reply(payload);
            mc.port1.close();
          };
          timer = setTimeout(() => finish({ ok: false, error: "find: page did not answer" }), 10000);
          mc.port1.onmessage = (ev) => {
            const d = ev.data as {
              ok?: boolean;
              error?: string;
              matches?: number;
              ordinal?: number;
              highlight?: string;
            };
            finish(
              d && typeof d.ok === "boolean"
                ? { ok: d.ok, error: d.error, matches: d.matches, ordinal: d.ordinal, highlight: d.highlight }
                : { ok: false, error: "bad find reply" },
            );
          };
          const cs = await self.clients.matchAll({ type: "window" });
          let target: Client | null = null;
          for (const c of cs) {
            try {
              const cu = new URL(c.url, self.location.origin);
              if (decodeClientUrl(cu) === msg.dest) {
                target = c;
                break;
              }
            } catch { /* not a routable client URL: skip */ }
          }
          if (!target) {
            finish({ ok: false, error: "find: no proxied page at dest" });
            return;
          }
          target.postMessage(
            { type: "zl:findLoad", cmd: msg.cmd, pattern: msg.pattern, options: msg.options, code },
            [mc.port2],
          );
        })(),
      );
      break;
    }
    case "zl:downloads":
      /* 1.7 Sulfide: registry snapshot, newest first. */
      reply({ ok: true, downloads: DL.snapshot() });
      break;
    case "zl:cancelDownload": {
      const id = msg.id;
      if (typeof id !== "string") {
        reply({ ok: false, error: "missing id" });
        break;
      }
      reply({ ok: DL.cancel(id) });
      break;
    }
    case "zl:pauseDownload": {
      const id = msg.id;
      if (typeof id !== "string") {
        reply({ ok: false, error: "missing id" });
        break;
      }
      /* #118: pause severs like cancel but keeps the entry resumable. */
      reply({ ok: DL.pause(id) });
      break;
    }
    case "zl:resumeDownload": {
      const id = msg.id;
      if (typeof id !== "string") {
        reply({ ok: false, error: "missing id" });
        break;
      }
      /* #118: async - the Range request goes through the wisp tunnel. */
      e.waitUntil(
        DL.resume(id).then(
          (r) => reply({ ok: r.ok, error: r.error }),
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:saveDownload": {
      const id = msg.id;
      if (typeof id !== "string") {
        reply({ ok: false, error: "missing id" });
        break;
      }
      /* #118: the UI host owns the save; the blob crosses the
         MessageChannel by structured clone. */
      e.waitUntil(
        DL.assemble(id).then(
          (a) =>
            reply(
              a
                ? { ok: true, blob: a.blob, filename: a.filename, mime: a.mime }
                : { ok: false, error: "no buffered artifact for this entry" },
            ),
          (err) => reply({ ok: false, error: String(err) }),
        ),
      );
      break;
    }
    case "zl:exportSession": {
      /* 1.7 Sulfide: encrypted session export (cookies + tabs +
         caller extras). The passphrase only ever lives in this
         message; the blob carries ciphertext. */
      const pass = msg.passphrase;
      if (typeof pass !== "string" || pass.length < 8) {
        reply({ ok: false, error: "passphrase must be at least 8 characters" });
        break;
      }
      e.waitUntil(
        (async () => {
          try {
            reply({
              ok: true,
              blob: await encryptSession(pass, {
                version: ZEOLITE_VERSION,
                created: Date.now(),
                cookies: [...jarSnapshot((e.source as { id?: string } | null)?.id)],
                tabs: TABS.list(),
                extra: msg.extra ?? null,
              }),
            });
          } catch (err) {
            reply({ ok: false, error: String(err) });
          }
        })(),
      );
      break;
    }
    case "zl:importSession": {
      const pass = msg.passphrase;
      if (typeof pass !== "string" || msg.blob === null || typeof msg.blob !== "object") {
        reply({ ok: false, error: "missing passphrase or blob" });
        break;
      }
      e.waitUntil(
        (async () => {
          try {
            const data = (await decryptSession(pass, msg.blob)) as {
              cookies?: Array<[string, unknown[]]>;
              extra?: unknown;
            };
            if (!Array.isArray(data.cookies)) throw new Error("no cookies in session blob");
            /* 2.2 Arsenide: merge mode with a per-cookie conflict rule;
               replace stays the default so existing callers are
               unchanged. */
            const cid = (e.source as { id?: string } | null)?.id;
            if (msg.mode === "merge") {
              const rule: JarConflictRule =
                msg.rule === "import-wins" || msg.rule === "keep-newest" ? msg.rule : "keep-existing";
              const counts = jarMerge(data.cookies, rule, cid);
              /* #254: the imported session is durable before the ack. */
              await flushJarPersist();
              reply({ ok: true, extra: data.extra ?? null, merged: counts });
            } else {
              jarReplace(data.cookies, cid);
              /* #254: the imported session is durable before the ack. */
              await flushJarPersist();
              reply({ ok: true, extra: data.extra ?? null });
            }
          } catch (err) {
            reply({ ok: false, error: String(err) });
          }
        })(),
      );
      break;
    }
    case "zl:sameSite":
      /* 2.2 Arsenide: opt-in SameSite policy knob on the jar. Unknown
         values fall back to "off" and the reply reports the effective
         policy so the caller cannot believe a bogus knob landed. */
      reply({ ok: true, policy: setSameSitePolicy(msg.policy) });
      break;
    case "zl:teardown":
      e.waitUntil(
        (async () => {
          // Close every bridged WebSocket first: no dangling streams.
          wsBridge.closeAll();
          // 1.4 Boride: cookies do not survive an engine switch.
          jarClear();
          // #254: the empty jar is durable before the ack.
          await flushJarPersist();
          // Drop every cache this SW owns, then unregister. Existing
          // pages lose their controller on next navigation; the adapter
          // also reloads them.
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
          reply({ ok: true });
          await self.registration.unregister();
        })(),
      );
      break;
    case "zl:getNetLog": {
      // Delta sync: the devtools page sends the last seq it has seen and
      // gets only newer entries, so polling stays cheap at any ring size.
      const since = (msg as { since?: number }).since ?? 0;
      const clientId = msg.clientId === undefined ? undefined : String(msg.clientId).slice(0, 256);
      const scoped = clientId === undefined ? null : netLogSince(0, clientId);
      reply({ entries: netLogSince(since, clientId), lastSeq: netLogCursor(), generation: netLogGeneration(), clientId: clientId ?? null,
          version: ZEOLITE_VERSION, stats: scoped === null ? transitStats() : {
            native: scoped.filter(x => x.transport === "NativeTransit").length,
            fallback: scoped.filter(x => x.transport === "RewriteFallback").length,
            fallbacks: scoped.filter(x => x.fallbackReason).map(x => ({ ts: x.ts, url: x.dest, reason: x.fallbackReason, traceId: x.traceId })),
          } });
      break;
    }
    case "zl:getDiag": {
      /* UI -> SW: diagnostics delta poll. Same cursor protocol as
         zl:getNetLog so the devtools page can poll both cheaply. */
      const since = (msg as { since?: number }).since ?? 0;
      const clientId = msg.clientId === undefined ? undefined : String(msg.clientId).slice(0, 256);
      reply({ ok: true, generation: netLogGeneration(), clientId: clientId ?? null, ...DIAG.snapshot(since, clientId) });
      break;
    }
    default:
      reply({ ok: false, error: "unknown message" });
  }
}

export async function handleControlEvent(
  e: ExtendableMessageEvent,
  deps: ControlDeps,
): Promise<void> {
  /* Issue #17: the restored route shape settles asynchronously; a
     cold-start ping must not report the default shape mid-restore.
     Registry-dependent answers also wait for the restart-safe
     init, so a just-restarted worker serves real state. */
  const msg = e.data as ControlMessage;
  const port = e.ports[0];
  const reply = (payload: unknown) => port?.postMessage(payload);
  /* #495: Doctor must answer even when boot is wedged. It is never
     reachable from a proxied page, and it avoids dispatchCore's
     legacy cookie-context bookkeeping and all outbound traffic by
     default. The host owns any optional MCP exposure. */
  if (msg?.type === "zl:doctor") {
    if (senderIsProxiedPage(e)) {
      reply({ ok: false, error: "host-only control message" });
      return;
    }
    const boot = await observeDoctorBoot(deps.ready);
    const scriptUrl = self.location?.href;
    const assets = msg.probeAssets === true ?
      await probeDoctorAssets(scriptUrl ?? "", fetch) : [];
    const report = buildDoctor({
      engineVersion: ZEOLITE_VERSION,
      boot,
      scriptUrl,
      registrationScope: self.registration?.scope,
      expectedScope: typeof msg.expectedScope === "string" && msg.expectedScope.length <= 1024 ? msg.expectedScope : undefined,
      expectedVersion: typeof msg.expectedVersion === "string" && msg.expectedVersion.length <= 96 ? msg.expectedVersion : undefined,
      degraded: getEngineDegraded() !== null,
      transport: transportState(),
      selectedEngine: currentEngine(),
      relay: relayAvailable(),
      alternateWisp: altConfigured(),
      primaryWisp: primaryWispUrl(),
      policy: policyDoctorState(),
      rules: rulesDoctorState(),
      siteconfig: siteconfigDoctorState(),
    }, assets);
    reply({ ...report, kdl: msg.format === "kdl" ? doctorKdl(report) : undefined });
    return;
  }
  await deps.ready;

  /* Bug-scout (#41): a proxied page must not drive the control plane
     (read the net log, flip the jar, tear the engine down). Page-facing
     messages only; everything else needs a host sender. #48:
     extension-origin pages are extension code, not host pages - the
     sole exception is zl:extPage, and only from the client registered
     as that exact extension's page (the case re-checks it). */
  if (senderIsProxiedPage(e) && !PAGE_MESSAGES.has(String(msg?.type))) {
    const src = e.source as Client | null;
    const srcId = src && src.url ? src.id : "";
    const isExtPageCall =
      msg?.type === "zl:extPage" &&
      typeof msg?.extId === "string" &&
      srcId !== "" &&
      pageClientOf(srcId) === msg.extId;
    if (!isExtPageCall) {
      reply({ ok: false, error: "host-only control message" });
      return;
    }
  }

    if (msg && EXT_CONTROL_TYPES.has(msg.type)) {
    await dispatchExtControl(msg, { e, reply });
  } else {
    await dispatchCore(msg, { e, reply, port, persistRoute: deps.persistRoute });
  }

}

// Registry of the core zl: message types (#90): exactly the labels the
// switch in dispatchCore below handles. Plain data, so it survives the
// minified build intact; control.test.ts pins it against that switch, so
// the dispatch and the registry can never drift apart.
export const CORE_CONTROL_TYPES: ReadonlySet<string> = new Set([
  "zl:ping", "zl:config", "zl:mint", "zl:decodeRoutes", "zl:navHandle", "zl:adblock", "zl:rules", "zl:jarProfile", "zl:getJars", "zl:clearJar", "zl:transport", "zl:tracing", "zl:getTracing", "zl:siteRoute", "zl:wsOpen", "zl:docCookie", "zl:getVirtualOrigin", "zl:embedderOrigin", "zl:getEmbedder", "zl:fingerprint", "zl:recordStart", "zl:recordStop", "zl:find", "zl:downloads", "zl:cancelDownload", "zl:pauseDownload", "zl:resumeDownload", "zl:saveDownload", "zl:exportSession", "zl:importSession", "zl:sameSite", "zl:teardown", "zl:getNetLog", "zl:getDiag", "zl:doctor", "zl:loadState", "zl:relayRegister", "zl:reloadBypass", "zl:wispRegister", "zl:wispPrimary",
]);


/** #250: the message listener that keeps the event alive for the
    whole handler. waitUntil is called synchronously inside the
    listener (the browser only honors a lifetime extension made
    there); a handler error is caught so it can never surface as an
    unhandled rejection: recorded as a RUNTIME diag and, when the
    message carried a reply port, answered with a structured
    error. */
export function messageListener(deps: ControlDeps) {
  return (e: ExtendableMessageEvent): void => {
    e.waitUntil(
      handleControlEvent(e, deps).catch((err) => {
        DIAG.failure({
          category: "RUNTIME",
          cause: "failure",
          message: "control-plane message handler failed",
          technicalReason: String(err),
        });
        try {
          (e.ports[0] as PortLike | undefined)?.postMessage({ ok: false, error: "control handler failed" });
        } catch {
          /* reply port already dead: nothing to answer */
        }
      })
        /* #254: keep jar persistence alive for the whole message
           event; flushJarPersist never throws. */
        .then(() => (e.data as ControlMessage)?.type === "zl:doctor" ? undefined : flushJarPersist()),
    );
  };
}
