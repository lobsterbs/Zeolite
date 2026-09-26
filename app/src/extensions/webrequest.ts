/* Zeolite extension subsystem: webRequest bridge.

   Extension request interception wired into the engine's real fetch
   pipeline (see the service worker integration): onBeforeRequest can
   cancel a request (MV2-style blocking, honored only for extensions
   holding webRequestBlocking), onBeforeSendHeaders / onHeadersReceived
   can replace the header set with validated pairs, onCompleted /
   onErrorOccurred are observation-only. Delivery requires the
   webRequest permission at the API layer plus a host permission (or
   <all_urls>) matching the request URL, and each listener's own url
   filter is applied. The registry only ever sees requests the engine
   actually intercepted: nothing is fabricated, and requests the engine
   never handles (engine assets, other origins) are never reported. */

import { hostPatternsMatch } from "./permissions";
import type { ExtensionId } from "./types";

export type WrKind =
  | "beforeRequest"
  | "beforeSendHeaders"
  | "headersReceived"
  | "completed"
  | "errorOccurred";

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
  timeStamp: number;
}

export interface WrSendDetails extends WrDetails {
  requestHeaders: WrHeaderPair[];
}

export interface WrReceiveDetails extends WrDetails {
  statusCode: number;
  responseHeaders: WrHeaderPair[];
}

export interface WrCompletedDetails extends WrDetails {
  statusCode: number;
}

export interface WrErrorDetails extends WrDetails {
  error: string;
}

export type BeforeRequestListener = (d: WrDetails) => void | { cancel?: boolean };
export type BeforeSendHeadersListener = (d: WrSendDetails) => void | { requestHeaders?: WrHeaderPair[] };
export type HeadersReceivedListener = (d: WrReceiveDetails) => void | { responseHeaders?: WrHeaderPair[] };
export type CompletedListener = (d: WrCompletedDetails) => void;
export type ErrorOccurredListener = (d: WrErrorDetails) => void;

/** sec-fetch-dest -> webRequest resource type. Honest mapping: an
    unknown destination reports "other" rather than a guess. */
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
    default:
      return "other";
  }
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
  | ErrorOccurredListener;

interface ExtWrReg {
  hostPatterns: string[];
  canBlock: boolean;
  beforeRequest: Set<BeforeRequestListener>;
  beforeSendHeaders: Set<BeforeSendHeadersListener>;
  headersReceived: Set<HeadersReceivedListener>;
  completed: Set<CompletedListener>;
  errorOccurred: Set<ErrorOccurredListener>;
  /** Per-listener url filters, when the listener declared any. */
  filters: Map<AnyWrListener, string[]>;
}

export class WebRequestRegistry {
  private readonly exts = new Map<ExtensionId, ExtWrReg>();

  private reg(id: ExtensionId, opts: { hostPatterns: string[]; canBlock: boolean }): ExtWrReg {
    let r = this.exts.get(id);
    if (!r) {
      r = {
        hostPatterns: opts.hostPatterns,
        canBlock: opts.canBlock,
        beforeRequest: new Set(),
        beforeSendHeaders: new Set(),
        headersReceived: new Set(),
        completed: new Set(),
        errorOccurred: new Set(),
        filters: new Map(),
      };
      this.exts.set(id, r);
    }
    return r;
  }

  /** API layer: register one listener for one event kind. */
  register(
    id: ExtensionId,
    kind: WrKind,
    listener: AnyWrListener,
    opts: { hostPatterns: string[]; canBlock: boolean; urls: string[] },
  ): () => void {
    const r = this.reg(id, opts);
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
    }
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
      }
      r.filters.delete(listener);
    };
  }

  /** Delivery gate: the extension's host permissions plus the
      listener's own url filter must both match the request. */
  private visible(r: ExtWrReg, listener: AnyWrListener, url: string): boolean {
    if (!hostPatternsMatch(r.hostPatterns, url)) return false;
    const f = r.filters.get(listener);
    return !f || hostPatternsMatch(f, url);
  }

  /** Engine hook: true when a blocking listener cancelled the request.
      Non-blocking extensions observe onBeforeRequest but cannot
      cancel (Firefox semantics). */
  beforeRequest(d: WrDetails): boolean {
    for (const r of this.exts.values()) {
      for (const l of [...r.beforeRequest]) {
        if (!this.visible(r, l, d.url)) continue;
        let res: void | { cancel?: boolean };
        try {
          res = l(d);
        } catch {
          /* a broken listener is the extension's own problem */
          continue;
        }
        if (r.canBlock && res && res.cancel === true) return true;
      }
    }
    return false;
  }

  /** Engine hook: replacement request headers, or null to keep the
      originals. Header modification requires webRequestBlocking. */
  beforeSendHeaders(d: WrDetails, headers: Headers): Headers | null {
    let out: Headers | null = null;
    for (const r of this.exts.values()) {
      if (!r.canBlock) continue;
      for (const l of [...r.beforeSendHeaders]) {
        if (!this.visible(r, l, d.url)) continue;
        const pairs = headersToPairs(out ?? headers);
        let res: void | { requestHeaders?: WrHeaderPair[] };
        try {
          res = l({ ...d, requestHeaders: pairs });
        } catch {
          continue;
        }
        if (res && Array.isArray(res.requestHeaders)) {
          const h = pairsToHeaders(res.requestHeaders);
          if (h) out = h;
        }
      }
    }
    return out;
  }

  /** Engine hook: replacement response headers, or null to keep. */
  headersReceived(d: WrDetails, statusCode: number, headers: Headers): Headers | null {
    let out: Headers | null = null;
    for (const r of this.exts.values()) {
      if (!r.canBlock) continue;
      for (const l of [...r.headersReceived]) {
        if (!this.visible(r, l, d.url)) continue;
        const pairs = headersToPairs(out ?? headers);
        let res: void | { responseHeaders?: WrHeaderPair[] };
        try {
          res = l({ ...d, statusCode, responseHeaders: pairs });
        } catch {
          continue;
        }
        if (res && Array.isArray(res.responseHeaders)) {
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
          l(d);
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
          l(d);
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
