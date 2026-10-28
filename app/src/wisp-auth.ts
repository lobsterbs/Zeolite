/* WISP v2.1 password authentication, client side (#496).

   The server offers PasswordAuth as INFO extension 0x02 with a
   [required u8] metadata payload; the client replies with an INFO
   whose extension 0x02 payload is [user_len u8][user][password]
   (wisp-core extension.rs / frame.rs, the canonical codec). The
   shipped SW wisp client lives inside the vendored libcurl-transport
   bundle, which is never forked; but the bundle creates its wisp
   WebSocket through this scope's WebSocket constructor, the same
   seam the #74 wisp watcher wraps.

   Two adapter modes, selected by the caller's subprotocols:

   1. v1 upgrade (both shipped engines: the libcurl bundle calls
      new WebSocket(url) with no subprotocol and opens streams with
      wisp v1 CONNECT packets). For a credentialed endpoint the
      wrapper appends the "wisp" subprotocol so the server speaks
      v2, answers the server's opening INFO itself with a
      PasswordAuth client INFO, holds every vendor frame until the
      server's handshake CONTINUE, then releases them in order and
      passes everything through. The handshake frames propagate to
      the vendor: its v1 state machine tolerates them (an unknown
      INFO type is a warning, CONTINUE on stream 0 sets its send
      buffer size) and it flips connected on its FIRST message,
      which is what unblocks the engine's stream creation
      (libcurl-transport WispConnection). The vendor's v1 flow has no
      CONTINUE frames, so the wrapper also grants the v2 server
      per-stream send credits on the vendor's behalf (without
      credits the server relays no DATA).
   2. v2 native (a future vendor that requests "wisp" itself): the
      wrapper rewrites the first outgoing frame when it is a
      decodable wisp v2 client INFO on stream 0, preserving the
      vendor's own extensions and appending PasswordAuth; every
      later frame passes through untouched.

   Fail-closed rules (#496): credentials are memory-only (a worker
   restart drops them, the host re-pushes); ws:// is accepted only
   for loopback (local fixtures), wss:// everywhere else; when
   credentials are configured for an endpoint, a socket that cannot
   complete an authenticated v2 handshake within the deadline is
   closed instead of connecting unauthenticated (no silent
   downgrade). The secret never enters URLs, subprotocols,
   diagnostics or replies: zl:wispAuth and zl:ping report mode,
   endpoint and the last redacted outcome only. Server close
   reasons map to stable outcomes: 0xc0 invalid-credential, 0xc2
   auth-required, 0xc1 auth-unsupported. */

import { normalizeWispUrl } from "./config";
import { DIAG } from "./diag";

export type WispAuthOutcome = "auth-required" | "invalid-credential" | "auth-unsupported";

export interface WispAuthStatus {
  mode: "none" | "password";
  /** Matching endpoint (origin + pathname), never the secret. */
  endpoint: string | null;
  /** True when the endpoint is wss://; loopback ws:// is allowed for
      local test fixtures and reported honestly as false. */
  secure: boolean;
  /** Last server close outcome observed on a credentialed socket. */
  lastOutcome: WispAuthOutcome | null;
}

const EXT_PASSWORD_AUTH = 0x02;
const PKT_CONNECT = 0x01;
const PKT_DATA = 0x02;
const PKT_INFO = 0x05;
const PKT_CONTINUE = 0x03;
const PKT_CLOSE = 0x04;
const CLOSE_AUTH_BAD_CREDENTIALS = 0xc0;
const CLOSE_AUTH_BAD_SIGNATURE = 0xc1;
const CLOSE_AUTH_REQUIRED = 0xc2;
/** No v2 INFO/CONTINUE within this window: fail closed. */
const HANDSHAKE_TIMEOUT_MS = 10000;

/** v1 has no flow control, but the v2 server only relays DATA while
    its per-stream send window has credits (zeolite-server Window:
    one credit spent per DATA packet, credits arrive only from client
    CONTINUE packets). In upgrade mode the wrapper grants credits on
    the vendor's behalf and tops the window up at half. */
export const WISP_GRANT_PACKETS = 0x10000;

const enc = new TextEncoder();

let cred: { endpoint: string; user: string; password: string; secure: boolean } | null = null;
let lastOutcome: WispAuthOutcome | null = null;

function outcome(o: WispAuthOutcome): void {
  if (lastOutcome === o) return;
  lastOutcome = o;
  DIAG.emit({
    category: "TRANSPORT",
    severity: "warning",
    message: "wisp auth: " + o,
  });
}

/** origin + pathname; the #133 bustWispUrl generation bust rides the
    query and must not defeat the endpoint match. null when the URL
    does not parse. */
function endpointKey(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** Configure password credentials for one wisp endpoint (#496).
    Memory-only. Fails closed on a non-ws(s) endpoint, on ws://
    outside loopback, and on empty or out-of-bounds credentials. */
export function configureWispAuth(
  endpoint: string,
  user: string,
  password: string,
): { ok: boolean; error?: string } {
  const norm = normalizeWispUrl(endpoint);
  if (!norm) return { ok: false, error: "wisp auth endpoint must be a parseable ws:// or wss:// URL" };
  const secure = norm.startsWith("wss://");
  if (!secure && !isLoopback(norm)) {
    return { ok: false, error: "wisp auth refuses credentials over ws:// outside loopback (wss:// required)" };
  }
  const u = enc.encode(user);
  const p = enc.encode(password);
  if (u.length === 0) return { ok: false, error: "wisp auth username is empty" };
  if (u.length > 255) return { ok: false, error: "wisp auth username exceeds 255 bytes" };
  if (p.length === 0) return { ok: false, error: "wisp auth password is empty" };
  if (p.length > 1024) return { ok: false, error: "wisp auth password exceeds 1024 bytes" };
  const key = endpointKey(norm);
  if (!key) return { ok: false, error: "wisp auth endpoint does not parse" };
  cred = { endpoint: key, user, password, secure };
  lastOutcome = null;
  return { ok: true };
}

/** Drop the credentials (explicit host action). New sockets connect
    unauthenticated, which is the host's expressed intent; an armed
    in-flight socket is closed fail-closed by the wrapper. */
export function clearWispAuth(): void {
  cred = null;
}

/** Redacted status surface for zl:wispAuth / zl:ping. Never includes
    the secret. */
export function wispAuthStatus(): WispAuthStatus {
  return {
    mode: cred ? "password" : "none",
    endpoint: cred?.endpoint ?? null,
    secure: cred?.secure ?? true,
    lastOutcome,
  };
}

/** Pure: the PasswordAuth client payload [user_len u8][user][password]
    (wisp-core extension.rs password_auth_client). null on bounds
    violations. */
export function passwordAuthPayload(user: string, password: string): Uint8Array | null {
  const u = enc.encode(user);
  const p = enc.encode(password);
  if (u.length === 0 || u.length > 255 || p.length === 0 || p.length > 1024) return null;
  const out = new Uint8Array(1 + u.length + p.length);
  out[0] = u.length;
  out.set(u, 1);
  out.set(p, 1 + u.length);
  return out;
}

/** Pure: a complete wisp v2 client INFO carrying only the
    PasswordAuth extension, the wrapper's own handshake answer for a
    v1 vendor (#496 upgrade mode). */
export function clientInfoWithAuth(user: string, password: string): Uint8Array | null {
  const auth = passwordAuthPayload(user, password);
  if (!auth) return null;
  const out = new Uint8Array(12 + auth.length);
  out[0] = PKT_INFO;
  const dv = new DataView(out.buffer);
  out[5] = 2;
  out[6] = 1;
  out[7] = EXT_PASSWORD_AUTH;
  dv.setUint32(8, auth.length, true);
  out.set(auth, 12);
  return out;
}

const MAX_EXTS = 64;
const MAX_EXT_META = 4096;

function u32le(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
}

/** Pure: append the PasswordAuth extension to a wisp v2 client INFO
    frame. Frame layout (wisp-core frame.rs encode_packet): [type
    0x05][stream u32 LE][major u8][minor u8][per extension: id u8,
    len u32 LE, meta]. Strict bounds: stream must be 0, at most 64
    extensions, 4096 metadata bytes each, no trailing bytes. Returns
    null when the frame is not a decodable v2 INFO. */
export function appendPasswordAuth(
  frame: Uint8Array,
  user: string,
  password: string,
): Uint8Array | null {
  if (frame.length < 7 || frame[0] !== PKT_INFO) return null;
  if (u32le(frame, 1) !== 0) return null;
  const exts: Array<[number, Uint8Array]> = [];
  let pos = 7;
  while (pos < frame.length) {
    if (pos + 5 > frame.length || exts.length >= MAX_EXTS) return null;
    const id = frame[pos];
    const len = u32le(frame, pos + 1);
    if (len < 0 || len > MAX_EXT_META || pos + 5 + len > frame.length) return null;
    exts.push([id, frame.slice(pos + 5, pos + 5 + len)]);
    pos += 5 + len;
  }
  const auth = passwordAuthPayload(user, password);
  if (!auth) return null;
  const total = 7 + exts.reduce((n, [, m]) => n + 5 + m.length, 0) + 5 + auth.length;
  const out = new Uint8Array(total);
  out.set(frame.slice(0, 7), 0);
  const dv = new DataView(out.buffer);
  let w = 7;
  for (const [id, meta] of exts) {
    out[w] = id;
    dv.setUint32(w + 1, meta.length, true);
    out.set(meta, w + 5);
    w += 5 + meta.length;
  }
  out[w] = EXT_PASSWORD_AUTH;
  dv.setUint32(w + 1, auth.length, true);
  out.set(auth, w + 5);
  return out;
}

/** Pure: translate a wisp v1 CONNECT frame into the v2 layout.
    The only wire difference between the versions is the CONNECT
    hostname field: v1 sends the raw hostname to the end of the
    payload, v2 prefixes it with a u8 length (wisp-core frame.rs
    parse_hostname; DATA, CONTINUE and CLOSE payloads are identical
    in both versions). Frame layout: [type][stream u32 LE][kind u8]
    [port u16 LE][host]. Returns null on malformed input. */
export function upgradeConnectFrame(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 8 || frame[0] !== PKT_CONNECT) return null;
  const hostLen = frame.length - 8;
  if (hostLen > 255) return null;
  const out = new Uint8Array(frame.length + 1);
  out.set(frame.slice(0, 8), 0);
  out[8] = hostLen;
  out.set(frame.slice(8), 9);
  return out;
}

/** Pure: map a wisp CLOSE frame (stream 0) reason byte to a stable
    redacted auth outcome; null for every other frame or reason. */
export function closeAuthOutcome(frame: Uint8Array): WispAuthOutcome | null {
  if (frame.length < 6 || frame[0] !== PKT_CLOSE) return null;
  if (u32le(frame, 1) !== 0) return null;
  switch (frame[5]) {
    case CLOSE_AUTH_BAD_CREDENTIALS:
      return "invalid-credential";
    case CLOSE_AUTH_REQUIRED:
      return "auth-required";
    case CLOSE_AUTH_BAD_SIGNATURE:
      return "auth-unsupported";
    default:
      return null;
  }
}

const AUTH_FLAG = "__zlWispAuth";

interface AuthGlobal {
  WebSocket?: typeof WebSocket;
  location?: { href: string };
}

function toBytes(d: unknown): Uint8Array | null {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) {
    const v = d as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

type HsState = "wait-info" | "wait-continue" | "done";

/** Wrap the scope's WebSocket so sockets to the credentialed endpoint
    complete a PasswordAuth v2 handshake (#496). Idempotent; a no-op
    where no WebSocket exists (tests, non-SW hosts). Composes with
    the #74 wisp watcher wrapper: each subclass calls the constructor
    it found, so either install order works. */
export function installWispAuthSocket(g: AuthGlobal = globalThis as AuthGlobal): void {
  const Orig = g.WebSocket;
  if (!Orig || (Orig as unknown as Record<string, unknown>)[AUTH_FLAG]) return;

  class ZlWispAuthWebSocket extends Orig {
    private armed = false;
    private nativeV2 = false;
    private hs: HsState = "wait-info";
    private rewrote = false;
    private held: Uint8Array[] = [];
    /* Upgrade-mode flow-control accounting: per stream, DATA packets
       forwarded since the last credit grant. */
    private credits = new Map<number, number>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(url: string | URL, protocols?: string | string[]) {
      const c = cred;
      const key = endpointKey(String(url));
      const matched = c !== null && key === c.endpoint;
      let protos: string | string[] | undefined = protocols;
      let native = false;
      if (matched) {
        const list: string[] =
          protocols === undefined ? [] : Array.isArray(protocols) ? [...protocols] : [protocols];
        native = list.some((p) => p.toLowerCase() === "wisp");
        if (!native) protos = [...list, "wisp"];
      }
      super(url, protos);
      this.armed = matched;
      if (!matched) return;
      this.nativeV2 = native;
      this.timer = setTimeout(() => {
        if (this.hs !== "done") this.failClosed("auth-unsupported");
      }, HANDSHAKE_TIMEOUT_MS);
      /* Registered before the transport's own listeners (the vendor
         adds its message listener after construction), so the wrapper
         answers the handshake before the vendor reacts to it. */
      this.addEventListener("message", (ev: MessageEvent) => this.onAuthMessage(ev));
    }
    private onAuthMessage(ev: MessageEvent): void {
      const bytes = toBytes(ev.data);
      if (!bytes) return;
      const o = closeAuthOutcome(bytes);
      if (o) {
        /* The server closed; the vendor sees the close too. A close
           before the handshake completed also drops the held frames
           and stops the deadline timer. */
        outcome(o);
        if (this.hs !== "done") this.failClosed();
        return;
      }
      if (this.nativeV2 || this.hs === "done") {
        this.maybeGrant(bytes);
        return;
      }
      if (this.hs === "wait-info") {
        if (bytes[0] !== PKT_INFO || u32le(bytes, 1) !== 0) return;
        /* The frame still propagates: the vendor's v1 state machine
           tolerates it (unknown packet type is a warning) and flips
           connected on its first message, which is what unblocks
           its stream creation (WispConnection). */
        this.hs = "wait-continue";
        const c = cred;
        const info = c ? clientInfoWithAuth(c.user, c.password) : null;
        if (!info) {
          this.failClosed();
          return;
        }
        super.send(info);
        return;
      }
      /* wait-continue: the handshake CONTINUE on stream 0 ends it.
         It also propagates: the vendor reads it as its stream-0
         send-buffer grant (v2 semantics it already implements). */
      if (bytes[0] === PKT_CONTINUE && u32le(bytes, 1) === 0) {
        const c = cred;
        this.hs = "done";
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (!c) {
          /* Credentials were cleared mid-flight: do not connect. */
          this.failClosed();
          return;
        }
        /* The vendor speaks v1 frames: each held CONNECT is
           translated into the v2 layout on release. */
        for (const f of this.held) {
          const up = f[0] === PKT_CONNECT ? upgradeConnectFrame(f) : f;
          if (!up) {
            this.failClosed("auth-unsupported");
            return;
          }
          super.send(up);
        }
        this.held = [];
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (!this.armed) {
        super.send(data);
        return;
      }
      if (this.nativeV2) {
        /* v2-native vendor: rewrite only its first outgoing frame. */
        if (this.rewrote) {
          super.send(data);
          return;
        }
        this.rewrote = true;
        const c = cred;
        const bytes = toBytes(data);
        const rewritten = c && bytes ? appendPasswordAuth(bytes, c.user, c.password) : null;
        if (!rewritten) {
          /* Fail closed (#496): an undecodable or non-synchronously-
             readable first frame never goes out unauthenticated. */
          this.failClosed("auth-unsupported");
          return;
        }
        super.send(rewritten);
        return;
      }
      /* v1 vendor upgrade: hold everything until the handshake is
         done, then translate CONNECTs and pass the rest through. */
      const bytes = toBytes(data);
      if (!bytes) {
        this.failClosed("auth-unsupported");
        return;
      }
      if (this.hs !== "done") {
        this.held.push(bytes);
        return;
      }
      if (bytes[0] === PKT_CONNECT) {
        const up = upgradeConnectFrame(bytes);
        if (!up) {
          this.failClosed("auth-unsupported");
          return;
        }
        super.send(up);
        return;
      }
      super.send(data);
    }
    /** Upgrade-mode flow-control shim (#496): a v1 vendor never sends
        CONTINUE, so without client credits the v2 server relays
        nothing after CONNECT. One grant per stream on first sight,
        topped up at half the window; counted in DATA packets to match
        the server's spend rule. Stream 0 window updates need no
        credit. No-op for native v2 vendors, which speak full v2. */
    private maybeGrant(bytes: Uint8Array): void {
      if (!this.armed || this.nativeV2 || bytes.length < 5) return;
      const t = bytes[0];
      const id = u32le(bytes, 1);
      if (t === PKT_CLOSE) {
        this.credits.delete(id);
        return;
      }
      if (t !== PKT_CONTINUE && t !== PKT_DATA) return;
      if (id === 0) return;
      if (!this.credits.has(id)) {
        this.credits.set(id, 0);
        this.grant(id);
        return;
      }
      if (t === PKT_CONTINUE) return;
      const n = (this.credits.get(id) ?? 0) + 1;
      if (n >= WISP_GRANT_PACKETS / 2) {
        this.credits.set(id, 0);
        this.grant(id);
      } else {
        this.credits.set(id, n);
      }
    }
    private grant(id: number): void {
      const out = new Uint8Array(9);
      const dv = new DataView(out.buffer);
      out[0] = PKT_CONTINUE;
      dv.setUint32(1, id, true);
      dv.setUint32(5, WISP_GRANT_PACKETS, true);
      super.send(out);
    }
    private failClosed(o?: WispAuthOutcome): void {
      if (o) outcome(o);
      this.hs = "done";
      this.held = [];
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      try {
        this.close();
      } catch {
        /* already closing */
      }
    }
  }

  (ZlWispAuthWebSocket as unknown as Record<string, unknown>)[AUTH_FLAG] = true;
  g.WebSocket = ZlWispAuthWebSocket;
}
