import { describe, it, expect, afterEach } from "vitest";
import { fingerprintScript, workerFingerprintScript, resolveProfile } from "../fingerprint";

/* #98: the canvas perturbation must be a read-time transform on a
   throwaway copy: the live canvas is never written back (native
   toDataURL/toBlob are side-effect free) and repeated reads are
   byte-identical (the old write-back drifted, which is itself a
   one-line anti-fingerprint detector). Evaluated against stub DOM
   classes so the behavior, not just the source text, is pinned. */

const profile = resolveProfile({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  canvasSeed: "canvas-test",
  utcOffsetMin: null,
  timezoneName: null,
});

let copySeq = 0;

class FakeCtx2D {
  canvas: { written: unknown };
  constructor(c: { written: unknown }) {
    this.canvas = c;
  }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4).fill(100), width: w, height: h };
  }
  putImageData(img: unknown, _x: number, _y: number) {
    this.canvas.written = img;
  }
}

class FakeCanvas {
  id: string;
  width = 4;
  height = 4;
  written: unknown = null;
  constructor(id = "canvas-" + copySeq++) {
    this.id = id;
  }
  getContext(kind: string) {
    return kind === "2d" ? new FakeCtx2D(this) : null;
  }
  toDataURL(...args: unknown[]) {
    return "encoded:" + this.id + ":" + args.join(",");
  }
  toBlob(cb: (b: unknown) => void) {
    cb("blob:" + this.id);
    return undefined;
  }
}

function installStubs() {
  const g = globalThis as Record<string, unknown>;
  g.Navigator = class {};
  g.HTMLCanvasElement = FakeCanvas;
  g.CanvasRenderingContext2D = FakeCtx2D;
  g.document = { createElement: () => new FakeCanvas() };
}

function removeStubs() {
  const g = globalThis as Record<string, unknown>;
  delete g.Navigator;
  delete g.HTMLCanvasElement;
  delete g.CanvasRenderingContext2D;
  delete g.document;
}

afterEach(removeStubs);

/* The stub copy ids auto-increment per call, so byte-identity is
   asserted with the id normalized away. */
const norm = (v: string) => v.replace(/canvas-\d+/g, "copy");

describe("canvas perturbation (#98)", () => {
  it("never writes perturbed pixels back into the live canvas", () => {
    installStubs();
    // eslint-disable-next-line no-eval
    (0, eval)(fingerprintScript(profile));
    const live = new FakeCanvas("live");
    const out = (live as unknown as { toDataURL: (t: string) => string }).toDataURL("image/png");
    // Encoded from a throwaway copy, not from the live canvas.
    expect(out.startsWith("encoded:")).toBe(true);
    expect(out).not.toContain("live");
    // The live canvas was never mutated.
    expect(live.written).toBeNull();
  });

  it("repeated reads are byte-identical", () => {
    installStubs();
    // eslint-disable-next-line no-eval
    (0, eval)(fingerprintScript(profile));
    const c = new FakeCanvas("live2") as unknown as { toDataURL: (t: string) => string };
    expect(norm(c.toDataURL("image/png"))).toBe(norm(c.toDataURL("image/png")));
  });

  it("toBlob encodes the perturbed copy and stays side-effect free", () => {
    installStubs();
    // eslint-disable-next-line no-eval
    (0, eval)(fingerprintScript(profile));
    const live = new FakeCanvas("live3");
    let seen: unknown = null;
    (live as unknown as { toBlob: (cb: (b: unknown) => void) => void }).toBlob((b) => (seen = b));
    expect(String(seen)).not.toContain("live3");
    expect(live.written).toBeNull();
  });

  it("getImageData perturbs only the returned copy, deterministically", () => {
    installStubs();
    // eslint-disable-next-line no-eval
    (0, eval)(fingerprintScript(profile));
    const ctx = new FakeCtx2D({ written: null });
    const a = ctx.getImageData(0, 0, 2, 2);
    const b = ctx.getImageData(0, 0, 2, 2);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    // Exactly the deterministic perturbed indices changed away from the base fill.
    const changed = Array.from(a.data).filter((v) => v !== 100).length;
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(4);
  });

  it("worker prelude perturbs a fresh OffscreenCanvas copy, never the source", () => {
    // String-level contract for the worker prelude: the perturbation
    // builds a copy (new OOC(...)) instead of writing back into the
    // source canvas.
    const s = workerFingerprintScript(profile);
    expect(s).toContain("var copy = new OOC(c.width, c.height)");
    // Encoder calls target the perturbed copy, with the source as fallback.
    expect(s).toContain("origBlob.apply(cp || this, arguments)");
    expect(s).toContain("origTIB.apply(cp || this, arguments)");
    // No write-back into the source canvas anywhere in the worker prelude.
    expect(s).not.toContain("ctx.putImageData");
  });
});
