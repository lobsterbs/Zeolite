import { describe, expect, it } from "vitest";
import { wsPayload } from "../ws-payload";

/* #493: Chromium's WebSocket BufferSource conversion rejects views
   backed by shared memory, before buffer accounting or bridge dispatch.
   The page and worker shims share this payload normalization seam. */
describe("WebSocket shared-buffer conversion (#493)", () => {
  it("rejects shared typed arrays and DataViews instead of accepting their byte length", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const backing = new SharedArrayBuffer(32);
    for (const value of [
      new Uint8Array(backing),
      new Uint8Array(backing, 5, 7),
      new DataView(backing, 4, 11),
      new Int32Array(backing, 8, 3),
    ]) {
      expect(() => wsPayload(value)).toThrow(TypeError);
    }
  });

  it("retains regular view offsets, byte counts, and identity", () => {
    const backing = new ArrayBuffer(24);
    const payloads = [
      [new Uint8Array(backing, 7, 9), 9],
      [new DataView(backing, 3, 5), 5],
      [new Int32Array(backing, 8, 3), 12],
    ] as const;
    for (const [view, bytes] of payloads) {
      const result = wsPayload(view);
      expect(result.data).toBe(view);
      expect(result.bytes).toBe(bytes);
    }
    expect(wsPayload(backing)).toEqual({ data: backing, bytes: 24 });
  });

  it("does not change Blob and UTF-8 text behavior", () => {
    const blob = new Blob(["abc"]);
    expect(wsPayload(blob)).toEqual({ data: blob, bytes: 3 });
    expect(wsPayload("☃").bytes).toBe(3);
    expect(() => wsPayload(Symbol("x"))).toThrow(TypeError);
  });
});
