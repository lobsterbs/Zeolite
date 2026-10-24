import { describe, expect, it } from "vitest";
import { b64uDecode, b64uEncode } from "../codec";

/* #423: the TS mirror of the Rust rewriter gate. The base64url
   decoder accepts exactly one encoding per byte string: impossible
   lengths (len % 4 === 1) and non-zero trailing bits are rejected
   instead of silently accepting alias encodings. */

describe("b64uDecode canonical-only (#423)", () => {
  it("rejects impossible lengths and non-zero trailing bits", () => {
    expect(b64uDecode("Y")).toBeNull();
    expect(b64uDecode("YWJjY")).toBeNull();
    expect(b64uDecode("YWJ")).toBeNull();
    expect(b64uDecode("eB")).toBeNull();
  });

  it("accepts the canonical forms of the same byte strings", () => {
    expect(Array.from(b64uDecode("YWI")!)).toEqual([0x61, 0x62]);
    expect(Array.from(b64uDecode("eA")!)).toEqual([0x78]);
    expect(Array.from(b64uDecode("")!)).toEqual([]);
  });

  it("round-trips canonical encodings byte for byte", () => {
    const enc = new TextEncoder();
    for (const s of ["", "a", "ab", "abc", "https://example.com/x?y=1"]) {
      const bytes = Array.from(enc.encode(s));
      expect(Array.from(b64uDecode(b64uEncode(enc.encode(s)))!)).toEqual(bytes);
    }
  });
});
