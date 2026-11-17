import { describe, expect, it } from "vitest";
import { withBodyStallDeadline } from "../request";

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      /* never enqueues again, never closes */
    },
  });
}

function silentBody(): ReadableStream<Uint8Array> {
  /* never enqueues, never closes: a dead upstream */
  return new ReadableStream<Uint8Array>({
    start() {
      /* nothing */
    },
  });
}

describe("withBodyStallDeadline (#140)", () => {
  it("errors an idle-stalled body within the deadline", async () => {
    const resp = new Response(stalledBody(), { status: 200, headers: { "content-type": "image/png" } });
    const wrapped = withBodyStallDeadline(resp, 60, "t1", "https://x.example/img.png", 60);
    const reader = wrapped.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.read()).rejects.toThrow(/body stall/);
  });

  it("keeps a stream that keeps sending bytes alive", async () => {
    let pulls = 0;
    const slow = new ReadableStream({
      async pull(controller) {
        pulls++;
        await new Promise((r) => setTimeout(r, 20));
        if (pulls >= 3) controller.close();
        else controller.enqueue(new Uint8Array([pulls]));
      },
    });
    const resp = new Response(slow, { status: 200, headers: { "content-type": "image/png" } });
    const wrapped = withBodyStallDeadline(resp, 500, "t2", "https://x.example/i.png");
    const text = await wrapped.text();
    expect(text.length).toBe(2);
  });

  it("skips event-stream responses and passes bodyless responses through", () => {
    const sse = new Response(stalledBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(withBodyStallDeadline(sse, 60, "t3", "u")).toBe(sse);
    const empty = new Response(null, { status: 204 });
    expect(withBodyStallDeadline(empty, 60, "t4", "u")).toBe(empty);
  });

  it("carries rawHeaders so the jar still sees set-cookie (#10)", () => {
    const resp = new Response(stalledBody(), { status: 200, headers: { "content-type": "text/html" } });
    (resp as Response & { rawHeaders?: Array<[string, string]> }).rawHeaders = [["set-cookie", "a=b; Path=/"]];
    const wrapped = withBodyStallDeadline(resp, 60, "t5", "https://x.example/") as Response & {
      rawHeaders?: Array<[string, string]>;
    };
    expect(wrapped.rawHeaders).toEqual([["set-cookie", "a=b; Path=/"]]);
  });

  /* #647/BUG-07: a long-poll that answered 200 headers and sent its
     first byte is proven alive; it may legitimately hold silence for
     minutes between reads (gemini batchexecute processSession). The
     tight 20s bound applies only until the first byte lands. */
  it("gives a silent long-poll the longer post-first-byte bound (#647)", async () => {
    const resp = new Response(stalledBody(), { status: 200, headers: { "content-type": "application/json" } });
    const wrapped = withBodyStallDeadline(resp, 40, "t9", "https://x.example/poll", 120);
    const reader = wrapped.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const second = reader.read();
    /* the pre-first-byte deadline (40ms) must NOT abort this read */
    await new Promise((r) => setTimeout(r, 70));
    const settledEarly = await Promise.race([second.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 0))]);
    expect(settledEarly).toBe(false);
    await expect(second).rejects.toThrow(/body stall/);
  });

  it("still errors a body silent before its first byte within ms (dead upstream)", async () => {
    const resp = new Response(silentBody(), { status: 200, headers: { "content-type": "application/json" } });
    const wrapped = withBodyStallDeadline(resp, 40, "t10", "https://x.example/poll");
    await expect(wrapped.body!.getReader().read()).rejects.toThrow(/body stall/);
  });
});

/* #200/#201: document bodies get the same idle bound as
   subresources, and a cancelled consumer cancels the upstream
   reader instead of leaving it buffered. */
describe("document stall bound and consumer cancel (#200/#201)", () => {
  it("applies the idle bound to document bodies too (#200)", async () => {
    const resp = new Response(stalledBody(), { status: 200, headers: { "content-type": "text/html" } });
    const wrapped = withBodyStallDeadline(resp, 60, "t6", "https://x.example/doc.html", 60);
    const reader = wrapped.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await expect(reader.read()).rejects.toThrow(/body stall/);
  });

  it("cancels the upstream reader when the consumer cancels (#201)", async () => {
    let cancelled = false;
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const resp = new Response(src, { status: 200, headers: { "content-type": "image/png" } });
    const wrapped = withBodyStallDeadline(resp, 500, "t7", "https://x.example/i.png");
    const reader = wrapped.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled).toBe(true);
  });

  /* 2026-11-11 YouTube repro: the wrapper's diag emitted one fixed
     "body stall deadline" message for every rejection, masking the
     real transport error (relay zl:relayError, abort). The stream
     must keep surfacing the ORIGINAL error to the page, and the
     wrapper must not swallow it. */
  it("preserves the upstream error through the wrapper", async () => {
    const boom = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("relay response queue limit exceeded"));
      },
    });
    const resp = new Response(boom, { status: 200, headers: { "content-type": "application/javascript" } });
    const wrapped = withBodyStallDeadline(resp, 60, "t8", "https://x.example/big.js");
    await expect(wrapped.text()).rejects.toThrow(/relay response queue limit exceeded/);
  });
});

