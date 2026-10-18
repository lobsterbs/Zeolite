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
   - streaming both ways, no full-body buffering: chunks ride the
     port as they arrive.
   - ponytail: GET/HEAD and string/ArrayBuffer bodies only; a stream
     body cannot ride the port, so such requests fall back to wisp.
   - ponytail: no per-message timeout here; the caller's TTFB
     deadline and the body-stall deadline remain the only clocks. */

import { DIAG } from "./diag";

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
      clients?: { matchAll(o: { type: string }): Promise<Array<{ postMessage(m: unknown): void }>> };
    } = typeof self !== "undefined" ? (self as unknown as typeof scope) : (globalThis as unknown as typeof scope);
    const cs = (await scope.clients?.matchAll({ type: "window" })) ?? [];
    for (const c of cs) c.postMessage({ type: "zl:relayLost" });
  } catch {
    /* no clients API in this realm: the bounded wait below still applies */
  }
  const got = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(hostPort !== null), deadlineMs);
    reRegisterWaiters.push(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!got) reRegisterBackoffUntil = Date.now() + 30_000;
  return got;
}

/** Control-plane half of zl:relayRegister: remember the embedder's
    port and route its answers to the pending fetches. */
export function relayRegister(port: MessagePort): void {
  hostPort = port;
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
export async function relayFetch(
  dest: string,
  init: { method: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal },
  traceId: string,
): Promise<Response | null> {
  const port = hostPort;
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
  const signal = init.signal;
  const abortErr = () => {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  };
  if (signal?.aborted) throw abortErr();
  const rid = ++ridSeq;
  const queue: RelayMsg[] = [];
  let wake: (() => void) | null = null;
  let aborted = false;
  const cancelUpstream = () => port.postMessage({ type: "zl:relayCancel", rid });
  waiters.set(rid, (m) => {
    queue.push(m);
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
  const take = (): Promise<RelayMsg> =>
    new Promise((resolve, reject) => {
      if (aborted) {
        reject(abortErr());
        return;
      }
      const m = queue.shift();
      if (m) resolve(m);
      else wake = () => (aborted ? reject(abortErr()) : resolve(queue.shift() as RelayMsg));
    });
  port.postMessage({
    type: "zl:fetchRelay",
    rid,
    dest,
    method: init.method,
    headers: Array.from(init.headers.entries()),
    body,
  });
  let first: RelayMsg;
  try {
    first = await take();
  } catch (err) {
    cleanup();
    throw err;
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
    return null;
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
    return null;
  }
  const h = new Headers();
  for (const [k, v] of first.headers) h.append(k, v);
  for (const c of first.setCookies ?? []) h.append("set-cookie", c);
  const nullBody = first.status === 204 || first.status === 205 || first.status === 304;
  const stream = new ReadableStream<Uint8Array>({
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