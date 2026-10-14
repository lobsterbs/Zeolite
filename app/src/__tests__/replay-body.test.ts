import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

/* #155: the upstreamFetch choke point buffers a POST body that
   arrives as a ReadableStream exactly once, so the relay can carry
   it (#137 accepts string/ArrayBuffer only) and the transport retry
   (#74) replays it instead of dying on a disturbed stream. */

import { replayableInit } from "../request";

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });

describe("replayableInit (#155 stream-body buffering)", () => {
  it("buffers a stream body once into the identical bytes", async () => {
    const out = await replayableInit({
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: streamOf(['{"a":', "1}"]),
    });
    expect(out.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(out.body as ArrayBuffer)).toBe('{"a":1}');
    expect(out.method).toBe("POST");
    expect(out.headers.get("content-type")).toBe("application/json");
  });

  it("is idempotent on an already-buffered body (the retry shape)", async () => {
    const buf = new TextEncoder().encode("abc");
    const init = { method: "POST", headers: new Headers(), body: buf.buffer as BodyInit };
    const out = await replayableInit(init);
    expect(out).toBe(init);
  });

  it("passes string and empty bodies through untouched", async () => {
    const s = { method: "POST", headers: new Headers(), body: "x=1" };
    expect(await replayableInit(s)).toBe(s);
    const e = { method: "GET", headers: new Headers(), body: undefined };
    expect(await replayableInit(e)).toBe(e);
  });

  it("keeps an announced oversized body streaming (no buffering)", async () => {
    const init = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    const out = await replayableInit(init);
    expect(out).toBe(init);
    const reader = (out.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value as Uint8Array)).toBe("hello");
  });
});
