import { describe, expect, it, beforeEach, vi } from "vitest";

/* #647 controlled A/B, app side. The Rust half of the pipeline is pinned
   in crates/rewriter/tests/videoplayback_numeric_fidelity.rs; this file
   pins the app-owned seams a player response passes through:

   1. the route codec: encodeDest/decodePath round-trips a videoplayback
      URL with the anomalous numeric fields byte-exact, and a single
      flipped digit inside the token fails the MAC (fails closed - a
      decode can never silently alter digits);
   2. the serve seams: boundedBody under the cap returns the exact bytes,
      and the over-cap passthroughStream reassembles byte-identical
      (head + rest), digits included. */

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

import { b64uDecode, b64uEncode, decodePath, encodeDest, setRouteKey, setScheme } from "../codec";
import { boundedBody, JS_BODY_CAP, passthroughStream } from "../transform";
import { decodeBody } from "../headers";

const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

/* The reported anomalous videoplayback URL (expire=8784516783 == mt,
   lmt=2944452072092938, dur=72844043, year 2248) plus a genuine one. */
const ANOMALOUS =
  "https://rr2---sn-q4flrner.googlevideo.com/videoplayback?expire=8784516783&mt=8784516783&lmt=2944452072092938&dur=72844043&itag=18&ip=46.57.69.50";
const GENUINE =
  "https://rr1---sn-q4flrnsd.googlevideo.com/videoplayback?expire=1794452226&mt=1794430686&lmt=1794355401938478&dur=220.000&itag=18";

/** A player-response-shaped body carrying both URLs, escaped the way
    ytInitialPlayerResponse spells them (`\/` and `\u003d`). */
function playerFixture(): string {
  const esc = (u: string) =>
    u.replace(/\//g, "\\/").replace(/=/g, "\\u003d");
  return (
    'var ytInitialPlayerResponse = {"streamingData":{"formats":[' +
    `{"itag":18,"url":"${esc(ANOMALOUS)}"},` +
    `{"itag":18,"url":"${GENUINE.replace(/\//g, "\\/")}"}` +
    ']},"playabilityStatus":{"status":"OK"}};'
  );
}

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

beforeEach(() => {
  setScheme("/j/");
  setRouteKey(null);
});

describe("#647 route codec numeric fidelity", () => {
  it("round-trips the anomalous videoplayback URL byte-exact (keyed)", () => {
    setRouteKey(KEY);
    const route = encodeDest(ANOMALOUS);
    expect(decodePath(route)).toBe(ANOMALOUS);
    const route2 = encodeDest(GENUINE);
    expect(decodePath(route2)).toBe(GENUINE);
  });

  it("round-trips byte-exact under the legacy codec", () => {
    setRouteKey(null);
    expect(decodePath(encodeDest(ANOMALOUS))).toBe(ANOMALOUS);
  });

  it("fails closed when a digit inside the token is flipped (MAC)", () => {
    setRouteKey(KEY);
    const route = encodeDest(ANOMALOUS);
    const tail = route.slice("/j/".length);
    const bytes = b64uDecode(tail)!;
    // flip one bit in the ciphertext region (past the 17-byte header)
    bytes[20] ^= 0x01;
    const tampered = "/j/" + b64uEncode(bytes);
    expect(decodePath(tampered)).toBeNull();
    // a digit swapped in the PLAINTEXT before encoding yields a valid but
    // different URL - i.e. the codec never rewrites digits itself
    const swapped = ANOMALOUS.replace("8784516783", "8784516784");
    expect(decodePath(encodeDest(swapped))).toBe(swapped);
    expect(decodePath(encodeDest(swapped))).not.toBe(ANOMALOUS);
  });
});

describe("#647 serve-seam body fidelity", () => {
  it("boundedBody under the cap returns the fixture bytes exactly", async () => {
    const enc = new TextEncoder();
    const fixture = playerFixture();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(fixture));
        c.close();
      },
    });
    const bb = await boundedBody(body);
    expect(bb.over).toBe(false);
    if (!bb.over) {
      expect(new TextDecoder().decode(bb.bytes)).toBe(fixture);
      // decodeBody (the under-cap serve path) is a pure charset decode
      expect(decodeBody(bb.bytes.buffer as ArrayBuffer, "text/javascript; charset=utf-8")).toBe(
        fixture,
      );
    }
  });

  it("over-cap passthroughStream reassembles byte-identical, digits intact", async () => {
    const enc = new TextEncoder();
    const head = enc.encode(playerFixture());
    const filler = new Uint8Array(JS_BODY_CAP - head.byteLength + 1); // push over the cap
    filler.fill(0x61);
    const tail = enc.encode(";window.__tail=8784516783;");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(head);
        c.enqueue(filler);
        c.enqueue(tail);
        c.close();
      },
    });
    const bb = await boundedBody(body);
    expect(bb.over).toBe(true);
    if (bb.over) {
      const out = await readAll(passthroughStream(null, bb.head, bb.rest));
      const expectBytes = new Uint8Array(head.byteLength + filler.byteLength + tail.byteLength);
      expectBytes.set(head, 0);
      expectBytes.set(filler, head.byteLength);
      expectBytes.set(tail, head.byteLength + filler.byteLength);
      expect(out.byteLength).toBe(expectBytes.byteLength);
      let diff = -1;
      for (let i = 0; i < expectBytes.byteLength; i++) {
        if (out[i] !== expectBytes[i]) {
          diff = i;
          break;
        }
      }
      expect(diff).toBe(-1); // byte-identical reassembly
      const text = new TextDecoder().decode(out);
      expect(text).toContain("expire\\u003d8784516783");
      expect(text).toContain("window.__tail=8784516783");
    }
  });
});
