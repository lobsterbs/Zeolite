/* #137: embedder relay for TLS-fingerprint-blocked hosts.

   duckduckgo.com-class hosts reject the wasm TLS ClientHello shapes
   at the handshake (libcurl: error 35 SSL connect; epoxy:
   UnexpectedEof) while native stacks from the same IP pass, so the
   transport itself is the block and per-site transport switching
   cannot fix it. When a policy rule routes a host to "relay", the
   engine asks the EMBEDDER origin to perform the fetch with its own
   network stack (native TLS, embedder-side SSRF validation) and
   streams the answer back over the port the embedder registered.

   Honesty rules that keep this a relay, not a second engine:
   - host-only channel: zl:relayRegister is a host control message,
     so the #41 sender gate already rejects proxied pages; page code
     can never register a relay port or drive embedder fetches.
   - the engine never fetches here: destination, method, headers and
     body cross to the embedder, and the SSRF judgment stays
     embedder-side by design.
   - response bodies stream over the port; request bodies use the
     existing bounded replay buffer at the upstream choke point.
   - ponytail: GET/HEAD and string/ArrayBuffer bodies only; a stream
     body cannot ride the port, so such requests fall back to wisp.
   - the relay header deadline is bounded. Idempotent delivery may
     fall back (#382); unknown POST/PATCH delivery fails without
     replay (#442). Large/multipart uploads have a finite 10min bound. */

import { TransportDeliveryError } from "./delivery";
import { DIAG } from "./diag";
import { isHostClient, type WinClient } from "./lifecycle";

type RelayMsg =
  | {
      type: "zl:relayHead";
      rid: number;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      setCookies?: string[];
    }
  | { type: "zl:relayChunk"; rid: number; bytes: Uint8Array }
  | { type: "zl:relayEnd"; rid: number }
  | { type: "zl:relayError"; rid: number; error: string };

let hostPort: MessagePort | null = null;
let ridSeq = 0;
const waiters = new Map<number, (m: RelayMsg) => void>();

/* #354: a plain idle restart of the service worker drops the stored
   port, and controllerchange does not fire for it, so the embedder
   never learns. A relay-routed fetch that finds no channel now asks
   every window client to re-register (zl:relayLost broadcast) and
   waits once, bounded; the fallback stays honest when no embedder
   answers in time, and a 30s backoff keeps embedder-less realms
   from paying the wait on every fetch. */
let reRegisterWaiters: Array<() => void> = [];
let reRegisterBackoffUntil = 0;

/** Ask the embedder to re-register its relay port, then wait once,
    bounded. True when a port is registered (possibly by a concurrent
    wait), false on the deadline or during the backoff window. */
export async function requestRelayReRegister(deadlineMs: number, traceId: string, dest: string): Promise<boolean> {
  if (hostPort) return true;
  if (Date.now() < reRegisterBackoffUntil) return false;
  DIAG.emit({
    traceId,
    requestId: traceId,
    category: "TRANSPORT",
    cause: "proxy",
    severity: "warning",
    stage: "UPSTREAM_REQUEST",
    message: "relay channel lost (worker restart?): asking the embedder to re-register",
    url: dest,
  });
  try {
    const scope: {
      clients?: { matchAll(o: { type: string }): Promise<Array<{ url?: string; postMessage(m: unknown): void }>> };
    } = typeof self !== "undefined" ? (self as unknown as typeof scope) : (globalThis as unknown as typeof scope);
    const cs = (await scope.clients?.matchAll({ type: "window" })) ?? [];
    /* #464: host clients only - a proxied page cannot register the
       relay (the control gate), so the recovery signal holds the
       same host-only boundary as the #439 lifecycle broadcast. */
    for (const c of cs) {
      try {
        if (isHostClient(c as unknown as WinClient)) c.postMessage({ type: "zl:relayLost" });
      } catch {
        /* unparseable client URL: not a host */
      }
    }
  } catch {
    /* no clients API in this realm: the bounded wait below still applies */
  }
  const got = await new Promise<boolean>((resolve) => {
    /* #463: the deadline removes its own waiter - an expired
       registration request must not linger in worker memory for
       the worker lifetime. */
    const waiter = () => {
      if (t !== undefined) clearTimeout(t);
      resolve(true);
    };
    let t: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      const i = reRegisterWaiters.indexOf(waiter);
      if (i >= 0) reRegisterWaiters.splice(i, 1);
      resolve(hostPort !== null);
    }, deadlineMs);
    reRegisterWaiters.push(waiter);
  });
  if (!got) reRegisterBackoffUntil = Date.now() + 30_000;
  return got;
}

/** Test seam: retained re-registration waiters (#463). */
export function reRegisterWaiterCount(): number {
  return reRegisterWaiters.length;
}

/* #391: the relay port, the embedder origin and the boot-page
   handshake state are worker memory; an idle restart drops them all
   and the embedder only re-arms on its own timer or when a relay
   fetch broadcasts zl:relayLost - which costs a 3s wait and can end
   in a 30s backoff (live-measured recovery: 33.9s). Asking every
   window client at worker start closes the gap before the first
   post-restart fetch: both the app page and the zlsw-register boot
   page re-register on this message. Harmless at first install -
   zero clients answer. */
export async function relayColdWake(): Promise<void> {
  try {
    const scope: {
      clients?: { matchAll(o: { type: string }): Promise<Array<{ url?: string; postMessage(m: unknown): void }>> };
    } = typeof self !== "undefined" ? (self as unknown as typeof scope) : (globalThis as unknown as typeof scope);
    const cs = (await scope.clients?.matchAll({ type: "window" })) ?? [];
    /* #464: host clients only - a proxied page cannot register the
       relay (the control gate), so the recovery signal holds the
       same host-only boundary as the #439 lifecycle broadcast. */
    for (const c of cs) {
      try {
        if (isHostClient(c as unknown as WinClient)) c.postMessage({ type: "zl:relayLost" });
      } catch {
        /* unparseable client URL: not a host */
      }
    }
  } catch {
    /* no clients API in this realm */
  }
}
/* Fires on every worker instance start (module eval), including the
   post-idle-restart wake the fetch handler runs on. */
if (typeof self !== "undefined") void relayColdWake();

/** Control-plane half of zl:relayRegister: remember the embedder's
    port and route its answers to the pending fetches. */
let hostCredits = false;

export function relayRegister(port: MessagePort, credits?: unknown): void {
  hostPort = port;
  /* #470: only an embedder that understands byte credits receives
     them; a legacy registration keeps the unbounded stream. */
  hostCredits = credits === 1;
  /* #354: a pending channel-less relay fetch may be waiting for
     exactly this registration; wake it (bounded wait resolves true). */
  const ws = reRegisterWaiters;
  reRegisterWaiters = [];
  ws.forEach((w) => w());
  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as RelayMsg;
    if (!m || typeof m.rid !== "number") return;
    waiters.get(m.rid)?.(m);
  };
}

export function relayAvailable(): boolean {
  return hostPort !== null;
}

/** One relayed fetch, or null when the relay cannot carry it (no
    channel, untransportable body) so the caller falls back to wisp. */
/** Longest wait for the embedder's first answer on a relayed fetch. */
export const RELAY_HEADER_DEADLINE_MS = 60_000;
export const RELAY_UPLOAD_HEADER_DEADLINE_MS = 600_000;
/** #470: bytes the SW grants a crediting embedder up front and back
    per drained chunk, so the producer can pace its reads. */
export const RELAY_CREDIT_BYTES = 2 * 1024 * 1024;
/** Upload time counts before response headers. Large buffered bodies
    and multipart uploads get a finite budget matching the host relay. */
export function relayHeaderDeadlineMs(init: { headers: Headers; body?: BodyInit | null }): number {
  const body = init.body;
  const size = typeof body === "string" ? body.length : body instanceof ArrayBuffer ? body.byteLength : 0;
  return body != null && (size > 512 * 1024 || /^multipart\/form-data\b/i.test(init.headers.get("content-type") ?? ""))
    ? RELAY_UPLOAD_HEADER_DEADLINE_MS : RELAY_HEADER_DEADLINE_MS;
}
/** Dispatch happened, so a POST/PATCH may already have succeeded.
    This terminal error prevents a second transport from duplicating it. */
export class RelayDeliveryUnknownError extends TransportDeliveryError {
  override name = "RelayDeliveryUnknownError";
  constructor(reason: string) {
    super("delivery-unknown", "relay", reason);
  }
}

export async function relayFetch(
  dest: string,
  init: { method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal },
  traceId: string,
): Promise<Response | null> {
  const port = hostPort;
  const crediting = hostCredits;
  if (!port) return null;
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof ArrayBuffer)) {
    return null;
  }
  /* #145: an aborted caller must not keep an embedder fetch alive.
     The abort rides both ways: the pending fetch (or body read)
     rejects with AbortError, and a zl:relayCancel frame tells the
     embedder to drop its /zlrelay connection, which drops the
     server-side upstream request instead of streaming it out. */
  const mayFallback = /^(GET|HEAD|OPTIONS|PUT|DELETE|TRACE)$/i.test(init.method);
  const failedAfterDispatch = (reason: string): null => {
    if (!mayFallback) throw new RelayDeliveryUnknownError("relay delivery outcome unknown; request not retried: " + reason);
    return null;
  };
  const signal = init.signal;
  const abortErr = () => {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  };
  if (signal?.aborted) throw abortErr();
  const rid = ++ridSeq;
  const queue: RelayMsg[] = [];
  let queuedBytes = 0;
  let terminal = false;
  let wake: (() => void) | null = null;
  let aborted = false;
  const cancelUpstream = () => port.postMessage({ type: "zl:relayCancel", rid });
  waiters.set(rid, (m) => {
    if (terminal) return;
    const bytes = m.type === "zl:relayChunk" ? m.bytes.byteLength : 0;
    // Bound both payload memory and zero-byte/control frame floods, including
    // legacy peers that cannot participate in the credit protocol.
    if (queuedBytes + bytes > RELAY_CREDIT_BYTES * 2 || queue.length >= 4096) {
      terminal = true;
      waiters.delete(rid);
      queue.length = 0;
      queuedBytes = 0;
      queue.push({ type: "zl:relayError", rid, error: "relay response queue limit exceeded" });
      try { cancelUpstream(); } catch { /* local failure still wakes the reader */ }
    } else {
      queuedBytes += bytes;
      queue.push(m);
    }
    const w = wake;
    wake = null;
    w?.();
  });
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    cancelUpstream();
    waiters.delete(rid);
    const w = wake;
    wake = null;
    w?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => {
    waiters.delete(rid);
    signal?.removeEventListener("abort", onAbort);
  };
  const shift = (): RelayMsg => {
    const m = queue.shift()!;
    if (m?.type === "zl:relayChunk") queuedBytes -= m.bytes.byteLength;
    return m;
  };
  const take = (): Promise<RelayMsg> =>
    new Promise((resolve, reject) => {
      if (aborted) {
        reject(abortErr());
        return;
      }
      const m = shift();
      if (m) resolve(m);
      else wake = () => (aborted ? reject(abortErr()) : resolve(shift()));
    });
  port.postMessage({
    type: "zl:fetchRelay",
    rid,
    dest,
    method: init.method,
    headers: Array.from(init.headers.entries()),
    body,
  });
  /* #470: the up-front credit grant; a non-crediting host never
     receives these frames. */
  if (crediting) port.postMessage({ type: "zl:relayCredit", rid, bytes: RELAY_CREDIT_BYTES });
  /* Header deadline for every relayed fetch, subresources included.
     Without it a silent embedder (or a port it dropped without a
     close event) parks the request until the page gives up. #382:
     a breach is channel death, not a caller error: resolve null so
     idempotent callers can fall back to their secondary transport.
     Non-idempotent delivery outcomes fail terminally (#442).
     Cancel the embedder upstream like a caller abort. An undeclared
     long-poll that would answer beyond
     the bound dies here honestly - the bound is what keeps dead
     channels from parking pages forever (a per-site override is
     the ponytail ceiling). */
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const headerDeadline = new Promise<null>((resolve) => {
    deadline = setTimeout(() => {
      /* Resolve before aborting: onAbort wakes take(), and the
         first settled promise decides what the caller sees. */
      resolve(null);
      onAbort();
      DIAG.emit({
        requestId: traceId,
        traceId,
        category: "TRANSPORT",
        cause: "proxy",
        severity: "warning",
        stage: "UPSTREAM_REQUEST",
        message: mayFallback ? "relay header deadline exceeded: treated as a dead channel, caller falls back" :
          "relay header deadline exceeded: delivery outcome unknown; request not retried",
        url: dest,
      });
    }, relayHeaderDeadlineMs(init));
  });
  let first: RelayMsg | null;
  try {
    first = await Promise.race([take(), headerDeadline]);
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    clearTimeout(deadline);
  }
  if (!first) {
    cleanup();
    return failedAfterDispatch("header deadline exceeded");
  }
  if (first.type === "zl:relayError") {
    cleanup();
    DIAG.emit({
      traceId,
      requestId: traceId,
      category: "TRANSPORT",
      cause: "proxy",
      severity: "warning",
      stage: "UPSTREAM_REQUEST",
      message: "embedder relay failed: " + first.error,
      url: dest,
    });
    return failedAfterDispatch(first.error);
  }
  if (first.type !== "zl:relayHead") {
    cleanup();
    DIAG.emit({
      traceId,
      requestId: traceId,
      category: "TRANSPORT",
      cause: "proxy",
      severity: "warning",
      stage: "UPSTREAM_REQUEST",
      message: "embedder relay protocol fault: " + first.type,
      url: dest,
    });
    cancelUpstream();
    return failedAfterDispatch("invalid relay response");
  }
  const h = new Headers();
  for (const [k, v] of first.headers) h.append(k, v);
  for (const c of first.setCookies ?? []) h.append("set-cookie", c);
  const nullBody = init.method.toUpperCase() === "HEAD" || first.status === 204 || first.status === 205 || first.status === 304;
  if (nullBody) {
    cleanup();
    queue.length = 0;
    queuedBytes = 0;
    cancelUpstream();
  }
  const stream = nullBody ? null : new ReadableStream<Uint8Array>({
    async pull(controller) {
      let m: RelayMsg;
      try {
        m = await take();
      } catch (err) {
        cleanup();
        controller.error(err);
        return;
      }
      if (m.type === "zl:relayChunk") {
        controller.enqueue(m.bytes);
        /* #470: grant the drained bytes back so a crediting embedder
           can pace its reads. */
        if (crediting) port.postMessage({ type: "zl:relayCredit", rid, bytes: m.bytes.byteLength });
        return;
      }
      cleanup();
      if (m.type === "zl:relayEnd") controller.close();
      else controller.error(new Error(m.type === "zl:relayError" ? m.error : "relay protocol fault"));
    },
    cancel() {
      cleanup();
      cancelUpstream();
    },
  });
  const out = new Response(nullBody ? null : stream, {
    status: first.status,
    statusText: first.statusText,
    headers: h,
  });
  /* #10: Response construction drops set-cookie (forbidden
     response-header name), so the jar rawHeaders view carries the
     relayed cookies explicitly; the embedder edge already strips
     them from what the page can read. */
  (out as Response & { rawHeaders?: Array<[string, string]> }).rawHeaders = [
    ...first.headers,
    ...(first.setCookies ?? []).map((c): [string, string] => ["set-cookie", c]),
  ];
  return out;
}