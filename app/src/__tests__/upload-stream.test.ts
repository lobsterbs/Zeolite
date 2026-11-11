/* #556: unit gates for the queue-backed upload controller that feeds
   the forked libcurl bundle's synchronous read callback. The fork's
   contract (vendor/libcurljs/FORK-NOTES.md): read(view, max) returns
   the count, 0 for EOF, -1 to pause (resumed via ctrl.resume()), -2
   to abort. */

import { describe, it, expect } from "vitest";
import { blobUploadController, UPLOAD_CHUNK_BYTES } from "../upload-stream";

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

describe("blobUploadController (#556)", () => {
  it("declares the chunk size and the exact content length", () => {
    const blob = new Blob([new Uint8Array(10)]);
    const ctrl = blobUploadController(blob);
    expect(ctrl.chunkSize).toBe(UPLOAD_CHUNK_BYTES);
    expect(ctrl.contentLength).toBe(10);
  });

  it("streams chunks in order and reports EOF", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
    const ctrl = blobUploadController(blob, 4);
    ctrl.resume = (): void => undefined;
    await tick();
    await tick();
    const view = new Uint8Array(4);
    expect(ctrl.read(view, 4)).toBe(4);
    expect(Array.from(view)).toEqual([1, 2, 3, 4]);
    expect(ctrl.read(view, 4)).toBe(4);
    expect(Array.from(view)).toEqual([5, 6, 7, 8]);
    expect(ctrl.read(view, 4)).toBe(0);
  });

  it("serves a partial chunk and keeps the remainder queued", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    const ctrl = blobUploadController(blob, 4);
    ctrl.resume = (): void => undefined;
    await tick();
    await tick();
    const view = new Uint8Array(2);
    expect(ctrl.read(view, 2)).toBe(2);
    expect(Array.from(view)).toEqual([1, 2]);
    expect(ctrl.read(view, 2)).toBe(2);
    expect(Array.from(view)).toEqual([3, 4]);
    expect(ctrl.read(view, 2)).toBe(1);
    expect(Array.from(view.subarray(0, 1))).toEqual([5]);
    expect(ctrl.read(view, 2)).toBe(0);
  });

  it("pauses when the queue runs dry and resumes on refill", async () => {
    /* A 3-chunk source with a queue cap of 2: the third chunk is still
       in flight when the queue drains, so the read callback must pause
       instead of reporting EOF. */
    const blob = new Blob([new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])]);
    const ctrl = blobUploadController(blob, 2);
    let resumes = 0;
    ctrl.resume = (): void => {
      resumes++;
    };
    const view = new Uint8Array(2);
    /* First synchronous read: the pump has not landed anything yet. */
    expect(ctrl.read(view, 2)).toBe(-1);
    /* The pump lands chunks 1 and 2 and resumes the transfer. */
    await tick();
    await tick();
    expect(resumes).toBeGreaterThanOrEqual(1);
    expect(ctrl.read(view, 2)).toBe(2);
    expect(Array.from(view)).toEqual([1, 2]);
    expect(ctrl.read(view, 2)).toBe(2);
    expect(Array.from(view)).toEqual([3, 4]);
    /* Chunk 3 needs a pump cycle: pause, then resume, then data. */
    const r = ctrl.read(view, 2);
    if (r === -1) {
      await tick();
      await tick();
      expect(ctrl.read(view, 2)).toBe(2);
      expect(Array.from(view)).toEqual([5, 6]);
    } else {
      expect(r).toBe(2);
      expect(Array.from(view)).toEqual([5, 6]);
    }
    expect(ctrl.read(view, 2)).toBe(0);
  });

  it("aborts with -2 when the source read fails", async () => {
    const bad = {
      size: 10,
      slice: (): Blob => {
        throw new Error("spool gone");
      },
    } as unknown as Blob;
    const ctrl = blobUploadController(bad);
    ctrl.resume = (): void => undefined;
    await tick();
    await tick();
    const view = new Uint8Array(4);
    expect(ctrl.read(view, 4)).toBe(-2);
    expect(ctrl.read(view, 4)).toBe(-2);
  });
});
