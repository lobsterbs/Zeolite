/* Zeolite extension subsystem: webRequest bridge.

   Extension request interception wired into the engine's real fetch
   pipeline (see the service worker integration): onBeforeRequest can
   cancel a request (MV2-style blocking, honored only for extensions
   holding webRequestBlocking), onBeforeSendHeaders / onHeadersReceived
   can replace the header set with validated pairs, onCompleted /
   onErrorOccurred are observation-only, and the #521 observe
   lifecycle (onSendHeaders, onBeforeRedirect, onResponseStarted)
   reports the wire events the engine's own hop chain produces.
   addListener validates the Firefox extraInfoSpec array and enforces
   it per listener (#521 slice 2): "blocking" opts a listener into
   cancel/header-replacement (still requiring webRequestBlocking),
   "requestHeaders"/"responseHeaders" gate the header fields, and a
   spec'd listener that asks for no blocking capability may register
   on the header-modifying events observe-only without the
   permission. Legacy no-spec registrations keep the MV2 blanket
   model. Delivery requires the
   webRequest permission at the API layer plus a host permission (or
   <all_urls>) matching the request URL, and each listener's own url
   filter is applied. The registry only ever sees requests the engine
   actually intercepted: nothing is fabricated, and requests the engine
   never handles (engine assets, other origins) are never reported. */

import { hostPatternsMatch } from "./permissions";
import { TABS } from "./tabs";
import type { ExtensionId } from "./types";

export type WrKind =
  | "beforeRequest"
  | "beforeSendHeaders"
  | "headersReceived"
  | "completed"
  | "errorOccurred"
  | "sendHeaders"
  | "beforeRedirect"
  | "responseStarted";

export interface WrHeaderPair {
  name: string;
  value: string;
}

export interface WrDetails {
  requestId: string;
  url: string;
  method: string;
  type: string;
  originUrl?: string;
  /* #702: the tab this request belongs to, resolved at interception
     from the UI tab registry by exact destination match (the same
     discipline as the webNavigation bridge). -1 when no known tab
     owns the request; a tab id is never fabricated. */
  tabId: number;
  /* #702: top-level frame markers, present only on main_frame
     loads, where the engine can vouch for them. */
  frameId?: number;
  parentFrameId?: number;
  timeStamp: number;
}

/* #521 slice 2: the requestHeaders/responseHeaders fields follow the
   Firefox extraInfoSpec model — present only when the listener's spec
   opts into them (or, legacy, when the listener predates the spec
   model and the extension holds webRequestBlocking). */
export interface WrSendDetails extends WrDetails {
  requestHeaders?: WrHeaderPair[];
}

export interface WrReceiveDetails extends WrDetails {
  statusCode: number;
  responseHeaders?: WrHeaderPair[];
}

export interface WrCompletedDetails extends WrDetails {
  statusCode: number;
}

export interface WrErrorDetails extends WrDetails {
  error: string;
}

/* #521 observe lifecycle: the wire events Firefox reports between the
   header stages and completion. onBeforeRedirect describes one
   followed hop (url = the hop that returned the 3xx, redirectUrl =
   the URL it redirects to); onResponseStarted fires on upstream
   responses after the final header set is settled and before any
   body byte streams (cache hits report onCompleted only). */
export interface WrRedirectDetails extends WrDetails {
  redirectUrl: string;
  statusCode: number;
  responseHeaders?: WrHeaderPair[];
}

export interface WrResponseStartedDetails extends WrDetails {
  statusCode: number;
}

export type BeforeRequestListener = (d: WrDetails) => void | { cancel?: boolean };
export type BeforeSendHeadersListener = (d: WrSendDetails) => void | { requestHeaders?: WrHeaderPair[] };
export type HeadersReceivedListener = (d: WrReceiveDetails) => void | { responseHeaders?: WrHeaderPair[] };
export type CompletedListener = (d: WrCompletedDetails) => void;
export type ErrorOccurredListener = (d: WrErrorDetails) => void;
export type SendHeadersListener = (d: WrSendDetails) => void;
export type BeforeRedirectListener = (d: WrRedirectDetails) => void;
export type ResponseStartedListener = (d: WrResponseStartedDetails) => void;

/** sec-fetch-dest -> webRequest resource type. Honest mapping:
    sec-fetch-dest "empty" is what browsers send for fetch()/XHR (and
    reqDest() reports it when the header is absent), so it surfaces as
    "xmlhttprequest"; a truly unknown destination reports "other"
    rather than a guess. */
export function wrType(destHeader: string): string {
  switch (destHeader.toLowerCase()) {
    case "document":
      return "main_frame";
    case "iframe":
    case "frame":
    case "object":
      return "sub_frame";
    case "style":
      return "stylesheet";
    case "script":
    case "worker":
    case "sharedworker":
    case "serviceworker":
      return "script";
    case "image":
      return "image";
    case "font":
      return "font";
    case "audio":
    case "video":
      return "media";
    case "websocket":
      return "websocket";
    case "empty":
      return "xmlhttprequest";
    default:
      return "other";
  }
}

/** #702: request-to-tab attribution. The UI tab registry is the
    only tab authority: a request belongs to a tab when the
    initiating page's virtual URL (or, for a main-frame load, the
    navigation target) is exactly one tab's url - the same
    exact-match rule as the webNavigation bridge. Loads belonging
    to no known tab report -1; a tab id is never invented, and
    sub-frame requests stay -1 unless their own URL matches a tab
    (the SW cannot see the frame's parent tab). */
export function wrTabFor(initiator: string | undefined, mainFrameUrl: string | undefined): number {
  for (const t of TABS.list()) {
    if ((initiator !== undefined && t.url === initiator) || (mainFrameUrl !== undefined && t.url === mainFrameUrl)) {
      return t.id;
    }
  }
  return -1;
}

/** Headers -> name/value pairs for listener-visible header arrays. */
export function headersToPairs(h: Headers): WrHeaderPair[] {
  const out: WrHeaderPair[] = [];
  for (const [k, v] of h) out.push({ name: k, value: v });
  return out;
}

/** Validated pairs -> Headers. Names must be non-empty strings and
    values strings; anything else is refused, never coerced. */
export function pairsToHeaders(pairs: unknown): Headers | null {
  if (!Array.isArray(pairs)) return null;
  const out = new Headers();
  for (const p of pairs) {
    if (typeof p !== "object" || p === null) return null;
    const name = (p as Record<string, unknown>).name;
    const value = (p as Record<string, unknown>).value;
    if (typeof name !== "string" || name.length === 0 || typeof value !== "string") {
      return null;
    }
    out.set(name, value);
  }
  return out;
}

type AnyWrListener =
  | BeforeRequestListener
  | BeforeSendHeadersListener
  | HeadersReceivedListener
  | CompletedListener
  | ErrorOccurredListener
  | SendHeadersListener
  | BeforeRedirectListener
  | ResponseStartedListener;

interface ExtWrReg {
  /* #282: live permission view, not a registration-time snapshot.
     Optional host permissions and webRequestBlocking can be revoked
     while a listener stays registered, so every delivery and blocking
     decision re-reads the owning extension's CURRENT grants through
     this getter (built by the API layer over the live record). */
  perm: () => { hostPatterns: string[]; canBlock: boolean };
  beforeRequest: Set<BeforeRequestListener>;
  beforeSendHeaders: Set<BeforeSendHeadersListener>;
  headersReceived: Set<HeadersReceivedListener>;
  completed: Set<CompletedListener>;
  errorOccurred: Set<ErrorOccurredListener>;
  sendHeaders: Set<SendHeadersListener>;
  beforeRedirect: Set<BeforeRedirectListener>;
  responseStarted: Set<ResponseStartedListener>;
  /** Per-listener extraInfoSpec, when the listener declared any.
      Recorded at addListener time; per-listener spec enforcement
      ("blocking" opt-in semantics) is the next #521 slice — blocking
      remains permission-gated registry-wide for now. */
  specs: Map<AnyWrListener, string[]>;
  /** Per-listener url filters, when the listener declared any. */
  filters: Map<AnyWrListener, string[]>;
}

export class WebRequestRegistry {
  private readonly exts = new Map<ExtensionId, ExtWrReg>();

  private reg(id: ExtensionId, perm: () => { hostPatterns: string[]; canBlock: boolean }): ExtWrReg {
    let r = this.exts.get(id);
    if (!r) {
      r = {
        perm,
        beforeRequest: new Set(),
        beforeSendHeaders: new Set(),
        headersReceived: new Set(),
        completed: new Set(),
        errorOccurred: new Set(),
        sendHeaders: new Set(),
        beforeRedirect: new Set(),
        responseStarted: new Set(),
        specs: new Map(),
        filters: new Map(),
      };
      this.exts.set(id, r);
    } else {
      /* #282: refresh the live-permission getter on every
         registration; an existing record must not stay pinned to
         the first registration's grant view. */
      r.perm = perm;
    }
    return r;
  }

  /** API layer: register one listener for one event kind. */
  register(
    id: ExtensionId,
    kind: WrKind,
    listener: AnyWrListener,
    opts: { perm: () => { hostPatterns: string[]; canBlock: boolean }; urls: string[]; spec?: string[] },
  ): () => void {
    const r = this.reg(id, opts.perm);
    switch (kind) {
      case "beforeRequest":
        r.beforeRequest.add(listener as BeforeRequestListener);
        break;
      case "beforeSendHeaders":
        r.beforeSendHeaders.add(listener as BeforeSendHeadersListener);
        break;
      case "headersReceived":
        r.headersReceived.add(listener as HeadersReceivedListener);
        break;
      case "completed":
        r.completed.add(listener as CompletedListener);
        break;
      case "errorOccurred":
        r.errorOccurred.add(listener as ErrorOccurredListener);
        break;
      case "sendHeaders":
        r.sendHeaders.add(listener as SendHeadersListener);
        break;
      case "beforeRedirect":
        r.beforeRedirect.add(listener as BeforeRedirectListener);
        break;
      case "responseStarted":
        r.responseStarted.add(listener as ResponseStartedListener);
        break;
    }
    if (opts.spec && opts.spec.length > 0) r.specs.set(listener, [...opts.spec]);
    if (opts.urls.length > 0) r.filters.set(listener, opts.urls);
    return () => {
      switch (kind) {
        case "beforeRequest":
          r.beforeRequest.delete(listener as BeforeRequestListener);
          break;
        case "beforeSendHeaders":
          r.beforeSendHeaders.delete(listener as BeforeSendHeadersListener);
          break;
        case "headersReceived":
          r.headersReceived.delete(listener as HeadersReceivedListener);
          break;
        case "completed":
          r.completed.delete(listener as CompletedListener);
          break;
        case "errorOccurred":
          r.errorOccurred.delete(listener as ErrorOccurredListener);
          break;
        case "sendHeaders":
          r.sendHeaders.delete(listener as SendHeadersListener);
          break;
        case "beforeRedirect":
          r.beforeRedirect.delete(listener as BeforeRedirectListener);
          break;
        case "responseStarted":
          r.responseStarted.delete(listener as ResponseStartedListener);
          break;
      }
      r.specs.delete(listener);
      r.filters.delete(listener);
    };
  }

  /** Delivery gate: the extension's CURRENT host permissions (#282)
      plus the listener's own url filter must both match the request
      URL. The url is always the immutable engine-side request URL,
      never a value a listener could have mutated (#272). */
  private visible(r: ExtWrReg, listener: AnyWrListener, url: string): boolean {
    if (!hostPatternsMatch(r.perm().hostPatterns, url)) return false;
    const f = r.filters.get(listener);
    return !f || hostPatternsMatch(f, url);
  }

  /** #521 slice 2: the listener's recorded extraInfoSpec, or null for
      a legacy listener with no spec. Legacy keeps the MV2 model —
      capability follows the webRequestBlocking permission alone, so
      every pre-spec registration behaves exactly as before. A spec'd
      listener gets Firefox's per-listener opt-in semantics instead. */
  private specOf(r: ExtWrReg, listener: AnyWrListener): string[] | null {
    const s = r.specs.get(listener);
    return s && s.length > 0 ? s : null;
  }

  /** May this listener actually cancel or replace header sets? The
      webRequestBlocking permission is still the gate the spec cannot
      lift; a spec'd listener must additionally have opted in with
      "blocking". */
  private mayModify(r: ExtWrReg, listener: AnyWrListener): boolean {
    if (!r.perm().canBlock) return false;
    const s = this.specOf(r, listener);
    return !s || s.includes("blocking");
  }

  /** Is a header field (requestHeaders/responseHeaders) present in
      this listener's details? Legacy blocking listeners always saw
      the field; spec'd listeners see it only when they asked. */
  private wantsField(r: ExtWrReg, listener: AnyWrListener, field: "requestHeaders" | "responseHeaders"): boolean {
    const s = this.specOf(r, listener);
    if (!s) return r.perm().canBlock;
    return s.includes(field);
  }

  /** Should this listener be invoked at all on a header event?
      Legacy: only blocking extensions get the header-modifying
      events (unchanged). Spec'd: whenever the spec asks for the
      blocking capability or the respective field. */
  private invited(r: ExtWrReg, listener: AnyWrListener, kind: "beforeSendHeaders" | "headersReceived"): boolean {
    const s = this.specOf(r, listener);
    if (!s) return r.perm().canBlock;
    return (
      s.includes("blocking") ||
      s.includes(kind === "beforeSendHeaders" ? "requestHeaders" : "responseHeaders")
    );
  }

  /** Engine hook: true when a blocking listener cancelled the request.
      Non-blocking extensions observe onBeforeRequest but cannot
      cancel (Firefox semantics). Each listener gets its own defensive
      copy of the details (#272): a mutated details object can never
      alter the data a later listener or a later request stage sees. */
  beforeRequest(d: WrDetails): boolean {
    for (const r of this.exts.values()) {
      for (const l of [...r.beforeRequest]) {
        if (!this.visible(r, l, d.url)) continue;
        let res: void | { cancel?: boolean };
        try {
          res = l({ ...d });
        } catch {
          /* a broken listener is the extension's own problem */
          continue;
        }
        if (this.mayModify(r, l) && res && res.cancel === true) return true;
      }
    }
    return false;
  }

  /** Engine hook: replacement request headers, or null to keep the
      originals. Header modification requires webRequestBlocking AND
      (for a spec'd listener) the "blocking" opt-in (#521 slice 2);
      a spec'd observe-only listener is delivered when it asked for
      requestHeaders, but its replacement is ignored. */
  beforeSendHeaders(d: WrDetails, headers: Headers): Headers | null {
    let out: Headers | null = null;
    for (const r of this.exts.values()) {
      for (const l of [...r.beforeSendHeaders]) {
        if (!this.visible(r, l, d.url)) continue;
        if (!this.invited(r, l, "beforeSendHeaders")) continue;
        const mayModify = this.mayModify(r, l);
        const wantsHeaders = this.wantsField(r, l, "requestHeaders");
        const pairs = headersToPairs(out ?? headers);
        let res: void | { requestHeaders?: WrHeaderPair[] };
        try {
          res = l(wantsHeaders ? { ...d, requestHeaders: pairs } : { ...d });
        } catch {
          continue;
        }
        if (mayModify && res && Array.isArray(res.requestHeaders)) {
          const h = pairsToHeaders(res.requestHeaders);
          if (h) out = h;
        }
      }
    }
    return out;
  }

  /** Engine hook: replacement response headers, or null to keep.
      Same per-listener model as beforeSendHeaders (#521 slice 2). */
  headersReceived(d: WrDetails, statusCode: number, headers: Headers): Headers | null {
    let out: Headers | null = null;
    for (const r of this.exts.values()) {
      for (const l of [...r.headersReceived]) {
        if (!this.visible(r, l, d.url)) continue;
        if (!this.invited(r, l, "headersReceived")) continue;
        const mayModify = this.mayModify(r, l);
        const wantsHeaders = this.wantsField(r, l, "responseHeaders");
        const pairs = headersToPairs(out ?? headers);
        let res: void | { responseHeaders?: WrHeaderPair[] };
        try {
          res = l(wantsHeaders ? { ...d, statusCode, responseHeaders: pairs } : { ...d, statusCode });
        } catch {
          continue;
        }
        if (mayModify && res && Array.isArray(res.responseHeaders)) {
          const h = pairsToHeaders(res.responseHeaders);
          if (h) out = h;
        }
      }
    }
    return out;
  }

  /** Engine hook: request finished successfully. */
  completed(d: WrCompletedDetails): void {
    for (const r of this.exts.values()) {
      for (const l of [...r.completed]) {
        if (!this.visible(r, l, d.url)) continue;
        try {
          l({ ...d });
        } catch {
          /* observation only; listener errors are ignored */
        }
      }
    }
  }

  /** Engine hook: request failed before completion. */
  errorOccurred(d: WrErrorDetails): void {
    for (const r of this.exts.values()) {
      for (const l of [...r.errorOccurred]) {
        if (!this.visible(r, l, d.url)) continue;
        try {
          l({ ...d });
        } catch {
          /* observation only; listener errors are ignored */
        }
      }
    }
  }

  /** Engine hook (#521): the FINAL outgoing header set (rules, DNR,
      blocking listeners, identity, jar) is about to hit the wire.
      Fired once per request, before the initial upstream fetch;
      redirect hops are reported by beforeRedirect instead. The pair
      list is a fresh copy per listener; a spec'd listener sees it
      only when it asked for requestHeaders (#521 slice 2). */
  sendHeaders(d: WrDetails, headers: Headers): void {
    for (const r of this.exts.values()) {
      for (const l of [...r.sendHeaders]) {
        if (!this.visible(r, l, d.url)) continue;
        try {
          const wantsHeaders = this.specOf(r, l) === null || this.wantsField(r, l, "requestHeaders");
          l(wantsHeaders ? { ...d, requestHeaders: headersToPairs(headers) } : { ...d });
        } catch {
          /* observation only; listener errors are ignored */
        }
      }
    }
  }

  /** Engine hook (#521): a redirect hop passed every gate and is
      about to be followed. url is the hop that returned the 3xx,
      redirectUrl the URL it redirects to. Breaks (one-shot stream
      bodies, missing or unresolvable Location) surface the 3xx
      without a followed hop and never reach this event. The 3xx
      response's headers are delivered only to listeners whose spec
      opts into responseHeaders (#521 slice 2). */
  beforeRedirect(d: WrDetails, redirectUrl: string, statusCode: number, headers?: Headers): void {
    for (const r of this.exts.values()) {
      for (const l of [...r.beforeRedirect]) {
        if (!this.visible(r, l, d.url)) continue;
        try {
          const wantsHeaders = headers !== undefined && this.wantsField(r, l, "responseHeaders");
          l(wantsHeaders ? { ...d, redirectUrl, statusCode, responseHeaders: headersToPairs(headers) } : { ...d, redirectUrl, statusCode });
        } catch {
          /* observation only; listener errors are ignored */
        }
      }
    }
  }

  /** Engine hook (#521): an upstream response's header set is settled
      and no body byte has streamed yet. Upstream path only — cache
      hits report onCompleted without network, so firing here would
      claim activity that never happened. */
  responseStarted(d: WrDetails, statusCode: number): void {
    for (const r of this.exts.values()) {
      for (const l of [...r.responseStarted]) {
        if (!this.visible(r, l, d.url)) continue;
        try {
          l({ ...d, statusCode });
        } catch {
          /* observation only; listener errors are ignored */
        }
      }
    }
  }

  /** Tests only: drop all registration state. */
  resetForTests(): void {
    this.exts.clear();
  }
}

export const WEBREQ = new WebRequestRegistry();

