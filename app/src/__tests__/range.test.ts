import { describe, expect, it } from "vitest";
import { planRange, ZL_RANGE_MAX } from "../range";
import { rangeFromEntry } from "../request";

const TOTAL = 2097152; // the compat fixture's /large body

describe("planRange (issue #18)", () => {
  it("slices the plain a-b form", () => {
    expect(planRange("bytes=0-1023", TOTAL)).toEqual({ kind: "slice", start: 0, end: 1023 });
    expect(planRange("bytes=100-199", TOTAL)).toEqual({ kind: "slice", start: 100, end: 199 });
  });

  it("clamps the end to the stored length", () => {
    expect(planRange("bytes=0-99999999", 100)).toEqual({ kind: "slice", start: 0, end: 99 });
  });

  it("open-ended a- runs to the end", () => {
    expect(planRange("bytes=1048576-", TOTAL)).toEqual({
      kind: "slice",
      start: 1048576,
      end: TOTAL - 1,
    });
  });

  it("suffix form takes the last N bytes", () => {
    expect(planRange("bytes=-500", 1000)).toEqual({ kind: "slice", start: 500, end: 999 });
    expect(planRange("bytes=-2000", 1000)).toEqual({ kind: "slice", start: 0, end: 999 });
  });

  it("416 when the range starts past the end", () => {
    expect(planRange("bytes=2097152-", TOTAL)).toEqual({ kind: "unsatisfiable" });
    expect(planRange("bytes=999999-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(planRange("bytes=-0", TOTAL)).toEqual({ kind: "unsatisfiable" });
  });

  it("multi-range and malformed headers bypass to the origin", () => {
    expect(planRange("bytes=0-1,5-9", TOTAL).kind).toBe("bypass");
    expect(planRange("bytes=", TOTAL).kind).toBe("bypass");
    expect(planRange("bytes=-", TOTAL).kind).toBe("bypass");
    expect(planRange("chunks=1-2", TOTAL).kind).toBe("bypass");
    expect(planRange("bytes=5-2", 100).kind).toBe("bypass");
  });
});


describe("rangeFromEntry (#314)", () => {
  it("refuses an oversized announced entry without buffering its body", async () => {
    /* #314: undici background-pulls a constructor stream body, so a
       pull flag cannot prove laziness; spy on arrayBuffer instead. */
    let buffered = false;
    const hit = new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-length": String(ZL_RANGE_MAX + 1) },
    });
    hit.arrayBuffer = async () => {
      buffered = true;
      return new Uint8Array().buffer;
    };
    await expect(rangeFromEntry(hit, "bytes=0-1")).resolves.toBeNull();
    expect(buffered).toBe(false);
  });

  it("still slices a small uncompressed entry: 206 + content-range", async () => {
    const hit = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4", "accept-ranges": "bytes" },
    });
    const out = await rangeFromEntry(hit, "bytes=1-2");
    expect(out).not.toBeNull();
    expect(out!.status).toBe(206);
    expect(out!.headers.get("content-range")).toBe("bytes 1-2/4");
    expect(new Uint8Array(await out!.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
  });

  it("measures when content-length is absent: 416 past the end", async () => {
    const hit = new Response(new Uint8Array([1, 2, 3, 4]), { headers: {} });
    const out = await rangeFromEntry(hit, "bytes=9-");
    expect(out).not.toBeNull();
    expect(out!.status).toBe(416);
    expect(out!.headers.get("content-range")).toBe("bytes */4");
  });

  it("does not advertise the stored body's length on an empty 416", async () => {
    const hit = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" },
    });
    const out = await rangeFromEntry(hit, "bytes=9-");
    expect(out!.status).toBe(416);
    expect(out!.headers.get("content-range")).toBe("bytes */4");
    expect(out!.headers.get("content-length")).toBeNull();
  });

  it("serves the slice without x-zl-* bookkeeping headers (#338)", async () => {
    const hit = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: {
        "content-length": "4",
        "x-zl-cached-at": "1",
        "x-zl-final-url": "https://real.example/x",
      },
    });
    const out = await rangeFromEntry(hit, "bytes=0-1");
    expect(out!.status).toBe(206);
    expect(out!.headers.get("x-zl-cached-at")).toBeNull();
    expect(out!.headers.get("x-zl-final-url")).toBeNull();
  });
});
