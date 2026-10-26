import { describe, expect, it } from "vitest";
import { wsPayload } from "../ws-payload";

describe("WebSocket outgoing payload bytes (#462)", () => {
  it("counts UTF-8 bytes, not characters or messages", () => {
    expect(wsPayload("abc")).toEqual({ data: "abc", bytes: 3 });
    expect(wsPayload("é")).toEqual({ data: "é", bytes: 2 });
    expect(wsPayload("𐀀")).toEqual({ data: "𐀀", bytes: 4 });
    expect(wsPayload(17)).toEqual({ data: "17", bytes: 2 });
  });

  it("uses the view's length, not the backing ArrayBuffer's length", () => {
    const backing = new ArrayBuffer(16);
    const view = new Uint8Array(backing, 4, 3);
    expect(wsPayload(backing).bytes).toBe(16);
    const result = wsPayload(view);
    expect(result.data).toBe(view);
    expect(result.bytes).toBe(3);
    expect(wsPayload(new DataView(backing, 2, 5)).bytes).toBe(5);
  });

  it("does not read or buffer Blobs to find their byte size", () => {
    const blob = new Blob(["é", new Uint8Array([0, 1, 2])]);
    const result = wsPayload(blob);
    expect(result.data).toBe(blob);
    expect(result.bytes).toBe(5);
  });

  it("rejects Symbols before posting a non-native payload", () => {
    expect(() => wsPayload(Symbol("bad"))).toThrow(TypeError);
  });
});
