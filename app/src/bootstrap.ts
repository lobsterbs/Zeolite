/* Zeolite runtime bootstrap. Injected into proxied HTML by the
   rewriter (<script src="/bootstrap.js"> right after <head> opens).

   Budget: under 5 KB minified (CI enforces). It only patches behavior:
   storage scoping, history, Worker constructors, WebSocket routing.
   URL-level fetch/XHR need no patch: pages navigate within engine-local
   paths that the service worker intercepts natively.

   Page-global contract (set by the rewriter at injection time):
     window.__ZL = { dest: "https://real.site/page" }
   falls back to document.baseURI when absent. */

const w = window as unknown as Record<string, unknown>;
const ZL = ((w.__ZL as { dest: string } | undefined) ??
  { dest: document.baseURI }) as { dest: string };

/* ---- per-site storage scoping ------------------------------------- */
/* Everything is prefixed by a short stable hash of the site origin:
   engine-origin storage is never touched by a proxied site, and two
   proxied sites never see each other's data. The prefix doubles as the
   session-export filter: everything under "zl:<site>:" travels in the
   blob, everything else stays put. */

function siteKey(): string {
  try {
    return String(new URL(ZL.dest).origin);
  } catch {
    return "unknown";
  }
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const SITE = "zl:" + fnv1a(siteKey());
const KEY = (k: string) => SITE + ":" + k;

/* One scanner for clear/key/length: keeps the scoped Storage cheap
   and the minified bootstrap inside its CI size budget. */
function siteKeys(store: Storage): string[] {
  const ks: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(SITE + ":")) ks.push(k);
  }
  return ks;
}

{
  const LS = w.localStorage;
  if (LS && typeof LS === "object") {
    const store = LS as Storage;
    const api = {
      getItem: (k: string) => store.getItem(KEY(k)),
      setItem: (k: string, v: string) => store.setItem(KEY(k), v),
      removeItem: (k: string) => store.removeItem(KEY(k)),
      clear: () => {
        siteKeys(store).forEach((k) => store.removeItem(k));
      },
      key: (i: number) => siteKeys(store)[i] ?? null,
      get length() {
        return siteKeys(store).length;
      },
    };
    const scoped = Object.assign(Object.create(Storage.prototype), api) as Storage;
    try {
      Object.defineProperty(w, "localStorage", { value: scoped, configurable: true });
    } catch { /* read-only context: storage then stays unscoped */ }
  }
}

/* ---- history ------------------------------------------------------- */
/* Same-origin engine paths mean pushState works natively; this patch
   only normalizes URL arguments so the address bar never leaks a raw
   destination string outside the engine path scheme. */

{
  const push = History.prototype.pushState;
  const replace = History.prototype.replaceState;
  History.prototype.pushState = function (s: unknown, t: string, u?: string | URL) {
    return push.call(this, s, t, u === undefined ? undefined : String(u));
  };
  History.prototype.replaceState = function (s: unknown, t: string, u?: string | URL) {
    return replace.call(this, s, t, u === undefined ? undefined : String(u));
  };
}

/* ---- Worker constructor ------------------------------------------- */
/* Workers load same-origin engine paths (intercepted by the SW); blob
   workers pass through untouched since their fetches go through the
   SW anyway. */

{
  const OW = w.Worker as (new (u: string | URL, o?: WorkerOptions) => Worker) | undefined;
  if (OW) {
    const W = function (u: string | URL, o?: WorkerOptions) {
      return new OW(String(u), o);
    } as unknown as typeof OW;
    W.prototype = OW.prototype;
    (w as { Worker?: unknown }).Worker = W;
  }
}

/* ---- WebSocket ---------------------------------------------------- */
/* The SW cannot intercept WebSocket upgrades, so ws(s):// URLs are
   routed by the bootstrap over a wisp TCP stream: the HTTP Upgrade
   handshake, RFC 6455 client framing, and server frame unwrapping all
   happen here. One wisp stream per WebSocket instance.

   Bug-scout fix: the first wisp DATA chunk usually carries the 101
   handshake response AND (sometimes) websocket frames in the same
   bytes. The handshake is now buffered separately until CRLFCRLF, the
   status line is verified to be 101 (non-101 dispatches error + close),
   and only the remainder is fed to the frame parser. */

{
  const OWS = w.WebSocket as
    | (new (u: string, p?: string | string[]) => WebSocket)
    | undefined;
  if (OWS) {
    const wispUrl =
      ((globalThis as { __ZL_WISP__?: string }).__ZL_WISP__) ??
      (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";

    type WispC = import("./wisp").WispClient;

    const LJWS = function (url: string, protocols?: string | string[]) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new DOMException(String(url), "SyntaxError");
      }
      if (u.protocol !== "ws:" && u.protocol !== "wss:") {
        // Non-ws schemes go through the native constructor so pages get
        // their normal error path.
        return protocols === undefined ? new OWS(url) : new OWS(url, protocols);
      }
      const port = u.port ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;

      const es = new EventTarget() as unknown as WebSocket;
      let wsState: number = WebSocket.CONNECTING;
      let streamId: number | null = null;
      const sendQ: Uint8Array[] = [];

      // Handshake bytes accumulate until CRLFCRLF; after 101 the parser
      // owns a separate rolling buffer for RFC 6455 frames.
      let hsBuf: Uint8Array = new Uint8Array(0);
      let wsOpen = false;

      function findCRLFCRLF(b: Uint8Array): number {
        for (let i = 0; i + 3 < b.length; i++) {
          if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
        }
        return -1;
      }
      function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
        const m = new Uint8Array(a.length + b.length);
        m.set(a);
        m.set(b, a.length);
        return m;
      }

      // Server frames can split across wisp DATA chunks: keep a
      // rolling buffer and unwrap only complete frames.
      let rxBuf = new Uint8Array(0);

      function unwrapServerFrames(bytes: Uint8Array): (string | ArrayBuffer)[] {
        const merged = concat(rxBuf, bytes);
        const msgs: (string | ArrayBuffer)[] = [];
        let i = 0;
        const dv = new DataView(merged.buffer);
        while (i + 2 <= merged.length) {
          const b0 = merged[i];
          const b1 = merged[i + 1];
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let off = i + 2;
          if (len === 126) {
            if (off + 2 > merged.length) break;
            len = dv.getUint16(off);
            off += 2;
          } else if (len === 127) {
            if (off + 8 > merged.length) break;
            const hi = dv.getUint32(off);
            const lo = dv.getUint32(off + 4);
            len = hi * 2 ** 32 + lo;
            off += 8;
          }
          let mask: Uint8Array | null = null;
          if (masked) {
            if (off + 4 > merged.length) break;
            mask = merged.subarray(off, off + 4);
            off += 4;
          }
          if (off + len > merged.length) break;
          let payload = merged.subarray(off, off + len);
          if (mask) {
            const un = new Uint8Array(len);
            for (let j = 0; j < len; j++) un[j] = payload[j] ^ mask[j % 4];
            payload = un;
          }
          if (opcode === 0x1) msgs.push(new TextDecoder().decode(payload));
          else if (opcode === 0x2) msgs.push(payload.slice().buffer);
          else if (opcode === 0x8) {
            wsState = WebSocket.CLOSED;
            // Real server close code when the frame carries one
            // (RFC 6455: 2-byte code + UTF-8 reason); 1005 when empty.
            const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
            es.dispatchEvent(
              new CloseEvent("close", {
                code,
                reason: new TextDecoder().decode(payload.subarray(2)),
              }),
            );
          }
          i = off + len;
        }
        rxBuf = merged.subarray(i).slice();
        return msgs;
      }

      function dispatchFrames(bytes: Uint8Array, client: WispC): void {
        for (const m of unwrapServerFrames(bytes)) {
          es.dispatchEvent(new MessageEvent("message", { data: m, origin: u.origin }));
        }
      }

      function failHandshake(client: WispC, code: number): void {
        wsState = WebSocket.CLOSED;
        es.dispatchEvent(new Event("error"));
        es.dispatchEvent(new CloseEvent("close", { code }));
        if (streamId !== null) void client.close(streamId, 0x02);
      }

      void (async () => {
        const { WispClient } = await import("./wisp");
        const client: WispC = new WispClient(wispUrl);
        const enc = new TextEncoder();

        streamId = await client.openStream(port, u.hostname, {
          onData: (chunk) => {
            if (!wsOpen) {
              hsBuf = concat(hsBuf, chunk);
              const sep = findCRLFCRLF(hsBuf);
              if (sep < 0) return; // handshake still in flight
              const head = new TextDecoder().decode(hsBuf.subarray(0, sep));
              const rest = hsBuf.subarray(sep + 4);
              hsBuf = new Uint8Array(0);
              // Status line must be "HTTP/1.1 101 ..." (or HTTP/1.0).
              if (!/^HTTP\/1\.[01] 101/.test(head)) {
                failHandshake(client, 1002);
                return;
              }
              wsOpen = true;
              wsState = WebSocket.OPEN;
              es.dispatchEvent(new Event("open"));
              for (const q of sendQ) void client.write(streamId!, q);
              sendQ.length = 0;
              if (rest.length) dispatchFrames(rest, client);
              return;
            }
            dispatchFrames(chunk, client);
          },
          onClose: () => {
            wsState = WebSocket.CLOSED;
            es.dispatchEvent(new CloseEvent("close", { code: wsOpen ? 1006 : 1002 }));
          },
        });

        const key = btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
        );
        const req =
          `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          (protocols !== undefined
            ? `Sec-WebSocket-Protocol: ${
                Array.isArray(protocols) ? protocols.join(", ") : protocols
              }\r\n`
            : "") +
          `Origin: ${u.origin}\r\n\r\n`;
        await client.write(streamId, enc.encode(req));

        (es as unknown as { __close: (c?: number) => void }).__close = async (code?: number) => {
          if (streamId !== null) await client.close(streamId, 0x02);
          wsState = WebSocket.CLOSED;
          es.dispatchEvent(new CloseEvent("close", { code: code ?? 1000 }));
        };
        (es as unknown as { __send: (d: unknown) => void }).__send = async (data: unknown) => {
          let bytes: Uint8Array;
          let op = 0x02;
          if (typeof data === "string") {
            bytes = new TextEncoder().encode(data);
            op = 0x01;
          } else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
          else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
          else if (ArrayBuffer.isView(data))
            bytes = new Uint8Array((data as Uint8Array).buffer, (data as Uint8Array).byteOffset, (data as Uint8Array).byteLength);
          else throw new DOMException("invalid data", "SyntaxError");
          // Client frames MUST be masked (RFC 6455).
          const mask = crypto.getRandomValues(new Uint8Array(4));
          let header: Uint8Array;
          if (bytes.length < 126) {
            header = new Uint8Array([0x80 | op, 0x80 | bytes.length]);
          } else if (bytes.length < 65536) {
            header = new Uint8Array([0x80 | op, 0x80 | 126, bytes.length >> 8, bytes.length & 0xff]);
          } else {
            header = new Uint8Array(10);
            header[0] = 0x80 | op;
            header[1] = 0x80 | 127;
            new DataView(header.buffer).setBigUint64(2, BigInt(bytes.length));
          }
          const frame = new Uint8Array(header.length + 4 + bytes.length);
          frame.set(header);
          frame.set(mask, header.length);
          const start = header.length + 4;
          for (let i = 0; i < bytes.length; i++) frame[start + i] = bytes[i] ^ mask[i % 4];
          if (!wsOpen) {
            sendQ.push(frame);
            return;
          }
          await client.write(streamId!, frame);
        };
      })();

      Object.defineProperties(es, {
        readyState: { get: () => wsState },
        url: { value: url },
        close: {
          value: (code?: number) => {
            const f = (es as unknown as { __close?: (c?: number) => void }).__close;
            void f?.(code);
          },
        },
        send: {
          value: (data: unknown) => {
            const f = (es as unknown as { __send?: (d: unknown) => void }).__send;
            void f?.(data);
          },
        },
      });

      return es;
    } as unknown as new (u: string, p?: string | string[]) => WebSocket;
    (LJWS as unknown as { prototype: object }).prototype = OWS.prototype;
    (w as { WebSocket?: unknown }).WebSocket = LJWS;
  }
}
