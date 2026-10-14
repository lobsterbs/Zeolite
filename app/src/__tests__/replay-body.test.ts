import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

/* #155: the upstreamFetch choke point buffers a POST body that
   arrives as a ReadableStream exactly once, so the relay can carry
   it (#137 accepts string/ArrayBuffer only) and the transport retry
   (#74) replays it instead of dying on a disturbed stream. */

import { replayCapTrips, replayableInit } from "../request";

const streamOf = (chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch);
      c.close();
    },
  });

describe("replayableInit (#155 stream-body buffering)", () => {
  it("buffers a stream body once into the identical bytes", async () => {
    const out = await replayableInit({
      method: "POST",
      headers: new Headers({ "content-type": "application/json", "content-length": "7" }),
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

  /* 2026-10-14 report: buffer only when a replay path can fire. */
  it("unannounced stream with no relay: passes through untouched (chunked/duplex class)", async () => {
    const init = {
      method: "POST",
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: streamOf(["partial"]),
    };
    const out = await replayableInit(init, { relayPossible: false });
    expect(out).toBe(init);
  });

  it("unannounced stream with a relay rule: buffered (the relay carries string/ArrayBuffer only)", async () => {
    const out = await replayableInit(
      {
        method: "POST",
        headers: new Headers(),
        body: streamOf(["a", "b"]),
      },
      { relayPossible: true },
    );
    expect(out.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(out.body as ArrayBuffer)).toBe("ab");
  });

  it("announced small body still buffers (the connect-class retry can replay it)", async () => {
    const out = await replayableInit({
      method: "POST",
      headers: new Headers({ "content-length": "2" }),
      body: streamOf(["hi"]),
    });
    expect(out.body).toBeInstanceOf(ArrayBuffer);
  });

  it("the cap is counted, not silent", async () => {
    const before = replayCapTrips();
    const big = {
      method: "POST",
      headers: new Headers({ "content-length": String(64 * 1024 * 1024) }),
      body: streamOf(["hello"]),
    };
    expect(await replayableInit(big)).toBe(big);
    expect(replayCapTrips()).toBe(before + 1);
    await expect(
      replayableInit(
        {
          method: "POST",
          headers: new Headers(),
          body: streamOf([new Uint8Array(33 * 1024 * 1024).fill(1)]),
        },
        { relayPossible: true },
      ),
    ).rejects.toThrow("replay buffer cap");
    expect(replayCapTrips()).toBe(before + 2);
  });
});
