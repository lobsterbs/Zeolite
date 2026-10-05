/* Epoxy adapter pure-surface tests (issue #64 slice 2): the
   rawHeaders pair conversion (the set-cookie gap: Response construction
   drops set-cookie past the fetch-spec forbidden-header filter, so the
   cookie jar reads the pairs the adapter rebuilds), the fetch-option
   parity (redirect "manual": epoxy follows redirects by default and the
   SW hop-follower owns redirect mapping), and the sync WsHandle bridge
   over epoxy's async connect_websocket: EpoxyHandlers ctor order, send
   buffering until the socket resolves, close-before-open delivery,
   close-code mapping (clean close 1000, error-then-close 1006: epoxy
   surfaces no peer close code), and the payload conversions. The real
   bundle round-trip is gated separately by the transport workflow
   (suite/epoxy-diag.mjs); these pin the adapter's own logic. */

import { describe, it, expect } from "vitest";
import {
  epoxyRawHeadersToPairs,
  epoxyFetchOptions,
  epoxyWsHandle,
  type WsHandlers,
} from "../libcurl-transport-vendored";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/* The EpoxyHandlers ctor order under test: (onopen, onclose, onerror,
   onmessage) - it differs from libcurl's connect(). */
class FakeHandlers {
  onopen: () => void;
  onclose: () => void;
  onerror: (err: unknown) => void;
  onmessage: (data: string | Uint8Array) => void;
  constructor(
    onopen: () => void,
    onclose: () => void,
    onerror: (err: unknown) => void,
    onmessage: (data: string | Uint8Array) => void,
  ) {
    this.onopen = onopen;
    this.onclose = onclose;
    this.onerror = onerror;
    this.onmessage = onmessage;
  }
}

interface Recorded {
  h: WsHandlers;
  events: string[];
  messages: Array<Blob | ArrayBuffer | string>;
}

function recorder(): Recorded {
  const events: string[] = [];
  const messages: Array<Blob | ArrayBuffer | string> = [];
  return {
    events,
    messages,
    h: {
      onopen: (protocol) => events.push("open:" + protocol),
      onmessage: (data) => {
        messages.push(data);
        events.push("msg");
      },
      onclose: (code, reason) => events.push("close:" + code + ":" + reason),
      onerror: (error) => events.push("err:" + error),
    },
  };
}

function fakeSocket(): {
  sends: Array<string | ArrayBuffer>;
  closes: Array<[number, string]>;
  send: (d: string | ArrayBuffer) => Promise<void>;
  close: (code: number, reason: string) => Promise<void>;
} {
  const sends: Array<string | ArrayBuffer> = [];
  const closes: Array<[number, string]> = [];
  return {
    sends,
    closes,
    send: (d) => {
      sends.push(d);
      return Promise.resolve();
    },
    close: (code, reason) => {
      closes.push([code, reason]);
      return Promise.resolve();
    },
  };
}

function deferredConnect(): {
  resolve: (s: unknown) => void;
  reject: (e: unknown) => void;
  connect: (constructed: unknown, url: string, protocols: string[], headers: Record<string, string>) => Promise<unknown>;
  seen: { constructed: unknown; url: string; protocols: string[]; headers: Record<string, string> } | null;
} {
  let resolve!: (s: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let seen: { constructed: unknown; url: string; protocols: string[]; headers: Record<string, string> } | null = null;
  const connect = (
    constructed: unknown,
    url: string,
    protocols: string[],
    headers: Record<string, string>,
  ): Promise<unknown> => {
    seen = { constructed, url, protocols, headers };
    return promise;
  };
  return { resolve, reject, connect, get seen() { return seen; } };
}

describe("epoxyRawHeadersToPairs", () => {
  it("flattens string values and multi-value arrays (set-cookie parity)", () => {
    expect(
      epoxyRawHeadersToPairs({
        "content-type": "text/html",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      }),
    ).toEqual([
      ["content-type", "text/html"],
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ]);
  });

  it("drops junk values instead of coercing them", () => {
    expect(
      epoxyRawHeadersToPairs({ n: 5, o: null, arr: [1, "ok", {}], s: "keep" }),
    ).toEqual([
      ["arr", "ok"],
      ["s", "keep"],
    ]);
  });

  it("returns [] for non-object input", () => {
    expect(epoxyRawHeadersToPairs(null)).toEqual([]);
    expect(epoxyRawHeadersToPairs(undefined)).toEqual([]);
    expect(epoxyRawHeadersToPairs("text/html")).toEqual([]);
    expect(epoxyRawHeadersToPairs(42)).toEqual([]);
  });
});

describe("epoxyFetchOptions", () => {
  it("defaults: GET, empty headers, null body, redirect manual", () => {
    expect(epoxyFetchOptions()).toEqual({
      method: "GET",
      headers: {},
      body: null,
      redirect: "manual",
    });
  });

  it("uppercases the method and passes request headers and body through", () => {
    const o = epoxyFetchOptions({
      method: "post",
      headers: [["x-a", "1"], ["x-b", "2"]],
      body: "payload",
    });
    expect(o.method).toBe("POST");
    expect(o.headers).toEqual({ "x-a": "1", "x-b": "2" });
    expect(o.body).toBe("payload");
  });

  it("never follows redirects: manual survives every input shape", () => {
    expect(epoxyFetchOptions({ redirect: "follow" }).redirect).toBe("manual");
    expect(epoxyFetchOptions().redirect).toBe("manual");
  });
});

describe("epoxyWsHandle", () => {
  it("maps the EpoxyHandlers ctor order onto the WsHandlers contract", () => {
    const rec = recorder();
    const d = deferredConnect();
    epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    const handlers = d.seen?.constructed as FakeHandlers;
    handlers.onopen();
    expect(rec.events).toEqual(["open:"]);
    handlers.onclose();
    expect(rec.events[1]).toBe("close:1000:"); // clean close: epoxy surfaces no peer code
    handlers.onerror("boom");
    expect(rec.events[2]).toBe("err:boom");
    handlers.onclose();
    expect(rec.events[3]).toBe("close:1006:"); // error-then-close: abnormal
  });

  it("passes url, protocols and the flattened header object to connect", () => {
    const rec = recorder();
    const d = deferredConnect();
    epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/x", ["chat"], [["x-a", "1"]]);
    expect(d.seen?.url).toBe("wss://w.example/x");
    expect(d.seen?.protocols).toEqual(["chat"]);
    expect(d.seen?.headers).toEqual({ "x-a": "1" });
    d.resolve(fakeSocket());
  });

  it("buffers sends until the socket resolves, then flushes in order", async () => {
    const rec = recorder();
    const d = deferredConnect();
    const sock = fakeSocket();
    const handle = epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    handle.send("one");
    handle.send("two");
    await flush();
    await flush();
    expect(sock.sends).toEqual([]);
    d.resolve(sock);
    await flush();
    await flush();
    expect(sock.sends).toEqual(["one", "two"]);
  });

  it("delivers a close-before-open to the socket once it resolves", async () => {
    const rec = recorder();
    const d = deferredConnect();
    const sock = fakeSocket();
    const handle = epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    handle.close(3001, "early");
    d.resolve(sock);
    await flush();
    expect(sock.closes).toEqual([[1000, ""]]); // clean close; the requested code does not cross the pending connect
    expect(sock.sends).toEqual([]);
  });

  it("forwards close(code, reason) to the live socket", async () => {
    const rec = recorder();
    const d = deferredConnect();
    const sock = fakeSocket();
    const handle = epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    d.resolve(sock);
    await flush();
    handle.close(3001, "bye");
    expect(sock.closes).toEqual([[3001, "bye"]]);
  });

  it("converts Blob payloads to ArrayBuffer once", async () => {
    const rec = recorder();
    const d = deferredConnect();
    const sock = fakeSocket();
    const handle = epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    d.resolve(sock);
    await flush();
    handle.send(new Blob([new Uint8Array([1, 2, 3])]));
    await flush();
    await flush();
    expect(sock.sends.length).toBe(1);
    expect(sock.sends[0] instanceof ArrayBuffer).toBe(true);
    expect(Array.from(new Uint8Array(sock.sends[0] as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("copies typed-array views into a standalone ArrayBuffer", async () => {
    const rec = recorder();
    const d = deferredConnect();
    const sock = fakeSocket();
    const handle = epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    d.resolve(sock);
    await flush();
    handle.send(new Uint8Array(new Uint8Array([0, 9, 8, 0]).buffer, 1, 2));
    await flush();
    await flush();
    expect(sock.sends.length).toBe(1);
    expect(Array.from(new Uint8Array(sock.sends[0] as ArrayBuffer))).toEqual([9, 8]);
  });

  it("surfaces a connect rejection as onerror, not a silent drop", async () => {
    const rec = recorder();
    const d = deferredConnect();
    epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    d.reject(new Error("no relay"));
    await flush();
    expect(rec.events).toContain("err:Error: no relay");
  });

  it("converts binary onmessage data to a standalone ArrayBuffer", () => {
    const rec = recorder();
    const d = deferredConnect();
    epoxyWsHandle(rec.h, FakeHandlers, d.connect as never, "wss://w.example/", [], []);
    const handlers = d.seen?.constructed as FakeHandlers;
    handlers.onmessage(new Uint8Array(new Uint8Array([65, 66]).buffer));
    expect(rec.messages.length).toBe(1);
    const m = rec.messages[0] as ArrayBuffer;
    expect(m instanceof ArrayBuffer).toBe(true);
    expect(Array.from(new Uint8Array(m))).toEqual([65, 66]);
  });
});
