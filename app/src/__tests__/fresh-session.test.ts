import { describe, expect, it, vi } from "vitest";
import { libcurlRequest } from "../libcurl-transport-vendored";

/* #454: a non-idempotent request must ride a per-request session (a
   fresh connection the wasm's libcurl cannot re-send from), closed
   when the body settles; idempotent methods stay on the pooled
   client. */
class FakeSession {
  static instances: FakeSession[] = [];
  static log: string[] = [];
  static nextResult: unknown = null;
  options: Record<string, unknown>;
  closed = 0;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeSession.instances.push(this);
    FakeSession.log.push("ctor");
  }
  async fetch(_url: string, params: Record<string, unknown>) {
    FakeSession.log.push("fetch " + String(params.method));
    const r = FakeSession.nextResult;
    if (r instanceof Error) throw r;
    return r as Response & { raw_headers?: Array<[string, string]> };
  }
  close_now() {
    this.closed++;
    FakeSession.log.push("close");
  }
}

function finishedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("hi"));
      c.close();
    },
  });
}

const HEADERS: Array<[string, string]> = [["a", "b"]];

/* Build a client whose pooled session is a FakeSession, then clear the
   instance log so only per-request sessions created by libcurlRequest
   count in the assertions below. */
function setup(next: unknown): { request: ReturnType<typeof vi.fn>; c: Parameters<typeof libcurlRequest>[0] } {
  const request = vi.fn().mockResolvedValue({ body: null, headers: [], status: 200, statusText: "OK" });
  const pooled = new FakeSession({ proxy: "socks5h://example/" });
  FakeSession.instances = [];
  FakeSession.log = [];
  FakeSession.nextResult = next;
  return { request, c: { request, session: pooled } as unknown as Parameters<typeof libcurlRequest>[0] };
}

describe("fresh-session dispatch (#454)", () => {
  it("routes a POST through a per-request session and closes it when the body drains (#454)", async () => {
    const { request, c } = setup({
      body: finishedStream(),
      status: 200,
      statusText: "OK",
      raw_headers: [["x", "y"]],
    });
    const res = await libcurlRequest(c, new URL("http://up.example/commit"), "POST", null, HEADERS, undefined);
    expect(request).not.toHaveBeenCalled();
    expect(FakeSession.instances.length).toBe(1);
    expect(FakeSession.log).toEqual(["ctor", "fetch POST"]);
    expect(FakeSession.instances[0].options).toEqual({ proxy: "socks5h://example/" });
    expect(res.status).toBe(200);
    expect(res.headers).toEqual([["x", "y"]]);
    await new Response(res.body as ReadableStream).arrayBuffer();
    expect(FakeSession.instances[0].closed).toBe(1);
  });

  it("keeps idempotent methods on the pooled client (#454)", async () => {
    const { request, c } = setup(null);
    await libcurlRequest(c, new URL("http://up.example/"), "GET", null, HEADERS, undefined);
    expect(request).toHaveBeenCalledTimes(1);
    expect(FakeSession.instances.length).toBe(0);
  });

  it("a rejected fresh fetch closes the session and rethrows (#454)", async () => {
    const { request, c } = setup(new Error("boom 52"));
    await expect(libcurlRequest(c, new URL("http://up.example/commit"), "POST", null, HEADERS, undefined)).rejects.toThrow("boom 52");
    expect(request).not.toHaveBeenCalled();
    expect(FakeSession.instances[0].closed).toBe(1);
  });

  it("a null body closes the fresh session immediately (#454)", async () => {
    const { request, c } = setup({ body: null, status: 204, statusText: "", raw_headers: [] });
    const res = await libcurlRequest(c, new URL("http://up.example/commit"), "POST", null, HEADERS, undefined);
    expect(request).not.toHaveBeenCalled();
    expect(res.body).toBeNull();
    expect(res.status).toBe(204);
    expect(FakeSession.instances[0].closed).toBe(1);
  });

  it("a consumer cancel closes the fresh session (#454)", async () => {
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const { request, c } = setup({ body: stream, status: 200, statusText: "OK", raw_headers: [] });
    const res = await libcurlRequest(c, new URL("http://up.example/commit"), "POST", null, HEADERS, undefined);
    expect(request).not.toHaveBeenCalled();
    const reader = (res.body as ReadableStream).getReader();
    ctrl?.enqueue(new TextEncoder().encode("x"));
    await reader.read();
    await reader.cancel();
    expect(FakeSession.instances[0].closed).toBe(1);
  });

  it("bundle drift (no session close_now) falls back to the pooled client request (#454)", async () => {
    const request = vi.fn().mockResolvedValue({ body: null, headers: [], status: 200, statusText: "OK" });
    const c = { request, session: { options: {} } } as unknown as Parameters<typeof libcurlRequest>[0];
    await libcurlRequest(c, new URL("http://up.example/commit"), "POST", null, HEADERS, undefined);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
