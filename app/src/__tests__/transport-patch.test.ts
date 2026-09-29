import { describe, expect, it } from "vitest";
import { applyTransportEOF } from "../libcurl-transport-vendored";

/* Drive the patched stream_response through a fake CurlSession seam:
   create_request captures the callbacks the wasm layer would invoke, so
   every scenario replays the exact callback ordering the real bundle
   produces (transcribed from libcurl.js 0.7.4 session.js and
   request.c). */

interface Captured {
  data: (chunk: Uint8Array) => void;
  end: (error: number) => void;
  headers: (chunk: Uint8Array) => void;
}

function makeSeam() {
  const captured: Captured[] = [];
  const curlProto: Record<string, unknown> = {
    stream_response() {
      throw new Error("original stream_response must not run after the patch");
    },
    create_request(
      _url: string,
      data: (chunk: Uint8Array) => void,
      end: (error: number) => void,
      headers: (chunk: Uint8Array) => void,
    ) {
      captured.push({ data, end, headers });
      return captured.length - 1;
    },
  };
  const session = Object.create(Object.create(curlProto));
  return { session, captured };
}

const enc = new TextEncoder();
const CLOSE_DELIMITED_302 = enc.encode(
  "HTTP/1.1 302 Found\r\nLocation: https://example.org/\r\n\r\n",
);
const LENGTH_DELIMITED_200 = enc.encode(
  "HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n",
);
const EMPTY_LENGTH_200 = enc.encode(
  "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
);

type Seam = {
  stream_response: (
    url: string,
    headers: (stream: ReadableStream) => void,
    end: (error: number) => void,
    signal?: AbortSignal,
  ) => number;
};

function start(
  seam: ReturnType<typeof makeSeam>,
  headers: (stream: ReadableStream) => void,
  end: (error: number) => void,
  signal?: AbortSignal,
) {
  const s = seam.session as unknown as Seam;
  const handle = s.stream_response(
    "https://example.org/",
    headers,
    end,
    signal,
  );
  expect(handle).toBe(0);
  return seam.captured[0];
}

async function readAll(stream: ReadableStream): Promise<number[]> {
  const reader = stream.getReader();
  const out: number[] = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    for (const b of r.value) out.push(b);
  }
  return out;
}

describe("applyTransportEOF", () => {
  it("applies to the CurlSession prototype and is idempotent", () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    expect(applyTransportEOF(seam.session)).toBe(true);
  });

  it("returns false when the seam is missing (bundle layout changed)", () => {
    expect(applyTransportEOF(Object.create({}))).toBe(false);
  });

  it("close-delimited empty-body error 56 surfaces the response before the rejection", async () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const order: string[] = [];
    const headerCalls: ReadableStream[] = [];
    const ends: number[] = [];
    const cbs = start(
      seam,
      (stream) => {
        headerCalls.push(stream);
        order.push("headers");
      },
      (error) => {
        order.push("end");
        ends.push(error);
      },
    );
    cbs.headers(CLOSE_DELIMITED_302);
    cbs.end(56);
    expect(order).toEqual(["headers", "end"]);
    expect(ends).toEqual([56]);
    expect(await readAll(headerCalls[0])).toEqual([]);
  });

  it("content-length: 0 with error 56 also surfaces (an empty body is complete)", async () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const headerCalls: ReadableStream[] = [];
    const ends: number[] = [];
    const cbs = start(
      seam,
      (stream) => headerCalls.push(stream),
      (error) => ends.push(error),
    );
    cbs.headers(EMPTY_LENGTH_200);
    cbs.end(56);
    expect(headerCalls).toHaveLength(1);
    expect(ends).toEqual([56]);
    expect(await readAll(headerCalls[0])).toEqual([]);
  });

  it("length-delimited error 56 before any body chunk still rejects with no response", () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const headerCalls: ReadableStream[] = [];
    const ends: number[] = [];
    const cbs = start(
      seam,
      (stream) => headerCalls.push(stream),
      (error) => ends.push(error),
    );
    cbs.headers(LENGTH_DELIMITED_200);
    cbs.end(56);
    expect(headerCalls).toHaveLength(0);
    expect(ends).toEqual([56]);
  });

  it("a throwing headers callback (status 0, no response) keeps the original rejection", () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const ends: number[] = [];
    const cbs = start(
      seam,
      () => {
        throw new RangeError("Failed to construct 'Response'");
      },
      (error) => ends.push(error),
    );
    cbs.headers(CLOSE_DELIMITED_302);
    cbs.end(56);
    expect(ends).toEqual([56]);
  });

  it("clean end with no body chunk still surfaces the response (upstream behavior)", () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const headerCalls: ReadableStream[] = [];
    const ends: number[] = [];
    const cbs = start(
      seam,
      (stream) => headerCalls.push(stream),
      (error) => ends.push(error),
    );
    cbs.headers(CLOSE_DELIMITED_302);
    cbs.end(0);
    expect(headerCalls).toHaveLength(1);
    expect(ends).toEqual([0]);
  });

  it("the first body chunk fires headers once and the body streams through", async () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const headerCalls: ReadableStream[] = [];
    const ends: number[] = [];
    const cbs = start(
      seam,
      (stream) => headerCalls.push(stream),
      (error) => ends.push(error),
    );
    cbs.headers(CLOSE_DELIMITED_302);
    cbs.data(new Uint8Array([65, 66]));
    cbs.end(0);
    expect(headerCalls).toHaveLength(1);
    expect(ends).toEqual([0]);
    expect(await readAll(headerCalls[0])).toEqual([65, 66]);
  });

  it("abort before headers rejects with -1 and never surfaces a response", () => {
    const seam = makeSeam();
    expect(applyTransportEOF(seam.session)).toBe(true);
    const controller = new AbortController();
    const headerCalls: ReadableStream[] = [];
    const ends: number[] = [];
    start(
      seam,
      (stream) => headerCalls.push(stream),
      (error) => ends.push(error),
      controller.signal,
    );
    controller.abort();
    expect(headerCalls).toHaveLength(0);
    expect(ends).toEqual([-1]);
  });
});
