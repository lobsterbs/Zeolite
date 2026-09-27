/* Public interception API (Phase 1, 1.1 Oxide). Standalone seam a
   host app (or plugin) uses to observe and shape proxied traffic.
   See docs/interception.md for the full contract.

   Kinds:
   - "request": every proxied request, before cache and transport.
     Handlers may block, rewrite the destination URL, or merge
     outgoing headers.
   - "response": every proxied response after hostile-header surgery.
     Header replacement, plus an OPT-IN body transform behind a hard
     size gate (BODY_LIMIT): huge responses are never buffered.
   - "navigation" | "worker" | "websocket" | "fetch": filtered views
     over the same request stream (document-mode, worker-dest,
     websocket-dest, subresource fetch/XHR); observe and block.

   Handlers run inside the service worker: no DOM, no page globals.
   A throwing handler is skipped, never breaks a request. */

import type { ResourceType } from "./rules";

export type InterceptKind =
  | "fetch"
  | "websocket"
  | "navigation"
  | "worker"
  | "request"
  | "response";

export interface InterceptRequestCtx {
  url: string;
  method: string;
  rtype: ResourceType;
  headers: Record<string, string>;
}

export interface InterceptRequestResult {
  /** Cancel the request (the page sees a 403). */
  block?: boolean;
  /** Rewrite the destination URL. */
  url?: string;
  /** Merge these into the outgoing headers (last write wins). */
  headers?: Record<string, string>;
}

export interface InterceptResponseCtx {
  url: string;
  status: number;
  rtype: ResourceType;
  headers: Record<string, string>;
}

export interface InterceptResponseResult {
  /** Merge these into the response headers the page sees. */
  headers?: Record<string, string>;
  /** OPT-IN body transform (text -> text). The SW applies it only
      when content-length is known and <= BODY_LIMIT, and never for
      documents/stylesheets (the streaming rewriter owns those). */
  body?: (text: string) => string;
}

export type RequestHandler = (ctx: InterceptRequestCtx) => InterceptRequestResult | void;
export type ResponseHandler = (ctx: InterceptResponseCtx) => InterceptResponseResult | void;

/** Hard size gate for body transforms. Responses larger than this
    (or of unknown size) pass through untouched, never buffered. */
export const BODY_LIMIT = 512 * 1024;

const reqHandlers: Record<Exclude<InterceptKind, "response">, RequestHandler[]> = {
  fetch: [],
  websocket: [],
  navigation: [],
  worker: [],
  request: [],
};

const resHandlers: ResponseHandler[] = [];

/** Register a handler for a kind. Returns an unregister function. */
export function intercept(
  kind: InterceptKind,
  handler: RequestHandler | ResponseHandler,
): () => void {
  if (kind === "response") {
    const h = handler as ResponseHandler;
    resHandlers.push(h);
    return () => {
      const i = resHandlers.indexOf(h);
      if (i >= 0) resHandlers.splice(i, 1);
    };
  }
  const h = handler as RequestHandler;
  const list = reqHandlers[kind];
  list.push(h);
  return () => {
    const i = list.indexOf(h);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Run the given request-kind handlers (sw internal). Any handler
    blocking blocks; the first URL rewrite wins; header maps merge. */
export function runRequestInterception(
  kinds: Exclude<InterceptKind, "response">[],
  ctx: InterceptRequestCtx,
): InterceptRequestResult {
  const out: InterceptRequestResult = {};
  for (const k of kinds) {
    for (const h of reqHandlers[k]) {
      let r: InterceptRequestResult | void;
      try {
        r = h(ctx);
      } catch {
        continue; // a broken handler never breaks a request
      }
      if (!r) continue;
      if (r.block) out.block = true;
      if (r.url && !out.url) out.url = r.url;
      if (r.headers) out.headers = { ...(out.headers ?? {}), ...r.headers };
    }
  }
  return out;
}

/** Run the response handlers (sw internal). The first declared body
    transform wins; header maps merge. */
export function runResponseInterception(
  ctx: InterceptResponseCtx,
): { headers?: Record<string, string>; body?: (text: string) => string } {
  const out: { headers?: Record<string, string>; body?: (text: string) => string } = {};
  for (const h of resHandlers) {
    let r: InterceptResponseResult | void;
    try {
      r = h(ctx);
    } catch {
      continue;
    }
    if (!r) continue;
    if (r.headers) out.headers = { ...(out.headers ?? {}), ...r.headers };
    if (r.body && !out.body) out.body = r.body;
  }
  return out;
}

/** Tests only: drop every registered handler. */
export function resetInterceptorsForTests(): void {
  for (const k of Object.keys(reqHandlers) as Exclude<InterceptKind, "response">[]) {
    reqHandlers[k].length = 0;
  }
  resHandlers.length = 0;
}
