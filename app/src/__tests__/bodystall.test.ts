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

describe("withBodyStallDeadline (#140)", () => {
  it("errors an idle-stalled body within the deadline", async () => {
    const resp = new Response(stalledBody(), { status: 200, headers: { "content-type": "image/png" } });
    const wrapped = withBodyStallDeadline(resp, 60, "t1", "https://x.example/img.png");
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
});
