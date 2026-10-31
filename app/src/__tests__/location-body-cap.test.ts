import { describe, expect, it, vi } from "vitest";

/* #456: the serve-seam half of the total candidate buffering bound.
   The wasm raw-pass half is pinned in Rust (html/mod.rs raw_pass
   tests); these tests pin the bounded lookahead contract: under the
   cap the body resolves to bytes, over the cap nothing is buffered
   whole, the passthrough stream is byte-faithful and cancel reaches
   the upstream reader. */

vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
  }
  return {
    JsRewriter,
    globalsStats: () => "0,0,0",
    default: async () => {},
  };
});

import { boundedBody, JS_BODY_CAP, passthroughStream } from "../transform";

const enc = new TextEncoder();

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const r = s.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function overCap(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(JS_BODY_CAP + 1));
      c.enqueue(enc.encode("tail"));
      c.close();
    },
  });
}

describe("boundedBody (#456 buffering bound)", () => {
  it("resolves under-cap bodies to bytes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("ab"));
        c.enqueue(enc.encode("cd"));
        c.close();
      },
    });
    const bb = await boundedBody(body);
    expect(bb.over).toBe(false);
    if (!bb.over) expect(new TextDecoder().decode(bb.bytes)).toBe("abcd");
  });

  it("treats a missing body as empty bytes", async () => {
    const bb = await boundedBody(null);
    expect(bb.over).toBe(false);
    if (!bb.over) expect(bb.bytes.byteLength).toBe(0);
  });

  it("returns over-cap bodies as a verbatim head plus rest", async () => {
    const bb = await boundedBody(overCap());
    expect(bb.over).toBe(true);
    if (!bb.over) return;
    const out = await readAll(passthroughStream(null, bb.head, bb.rest));
    expect(out.byteLength).toBe(JS_BODY_CAP + 1 + 4);
    expect(new TextDecoder().decode(out.subarray(JS_BODY_CAP + 1))).toBe("tail");
  });

  it("prepends the first chunk (worker prelude shape)", async () => {
    const bb = await boundedBody(overCap());
    expect(bb.over).toBe(true);
    if (!bb.over) return;
    const out = await readAll(passthroughStream(enc.encode("pre"), bb.head, bb.rest));
    expect(new TextDecoder().decode(out.subarray(0, 3))).toBe("pre");
    expect(out.byteLength).toBe(3 + JS_BODY_CAP + 1 + 4);
  });

  it("propagates cancel to the upstream reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(JS_BODY_CAP + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const bb = await boundedBody(body);
    expect(bb.over).toBe(true);
    if (!bb.over) return;
    const s = passthroughStream(null, bb.head, bb.rest);
    await s.cancel();
    expect(cancelled).toBe(true);
  });
});
