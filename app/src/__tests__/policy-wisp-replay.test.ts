import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { recoveryUpstream } from "../request";
import { compilePolicy } from "../policy";
import * as transport from "../transport";

const policy = compilePolicy('rule "alternate" { route "wisp" }');
/* The recovery seam invokes upstreamFetch directly; its public asset
   type only mentions GET headers, while the underlying request seam
   also accepts the body/signal exercised by these delivery fixtures. */
const fetchUpstream = () => recoveryUpstream(policy, "fetch", "policy-replay-fixture") as (
  url: string, init: { method: string; headers: Headers; body?: BodyInit; signal?: AbortSignal },
) => Promise<Response>;
let alternate: MockInstance<typeof transport.altWispFetch>;
let primary: MockInstance<typeof transport.wispTransport.fetch>;
beforeEach(() => {
  vi.spyOn(transport, "altConfigured").mockReturnValue(true);
  alternate = vi.spyOn(transport, "altWispFetch").mockRejectedValue(new Error("socket closed after dispatch"));
  primary = vi.spyOn(transport.wispTransport, "fetch").mockResolvedValue(new Response("primary"));
});
afterEach(() => vi.restoreAllMocks());

describe("policy Wisp fallback replay safety (#444)", () => {
  for (const method of ["POST", "PATCH"]) {
    it("does not resend " + method + " after unknown delivery", async () => {
      await expect(fetchUpstream()("https://api.example/write", { method, headers: new Headers(), body: "change" })).rejects.toThrow("socket closed after dispatch");
      expect(alternate).toHaveBeenCalledTimes(1);
      expect(primary).not.toHaveBeenCalled();
    });
  }

  it("keeps recovery for replayable idempotent requests", async () => {
    const response = await fetchUpstream()("https://api.example/read", { method: "GET", headers: new Headers() });
    expect(await response.text()).toBe("primary");
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("never sends another transport after the caller aborts", async () => {
    const controller = new AbortController();
    alternate.mockImplementation(async () => { controller.abort(); throw new Error("closed during cancellation"); });
    await expect(fetchUpstream()("https://api.example/read", { method: "GET", headers: new Headers(), signal: controller.signal })).rejects.toThrow();
    expect(primary).not.toHaveBeenCalled();
  });

  it("does not interpret an AbortError as a recoverable GET failure", async () => {
    alternate.mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await expect(fetchUpstream()("https://api.example/read", { method: "GET", headers: new Headers() })).rejects.toThrow("cancelled");
    expect(primary).not.toHaveBeenCalled();
  });

  it("does not dispatch a request whose signal was already aborted", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchUpstream()("https://api.example/read", { method: "GET", headers: new Headers(), signal: controller.signal })).rejects.toThrow();
    expect(alternate).not.toHaveBeenCalled();
    expect(primary).not.toHaveBeenCalled();
  });

  it("does not replay a one-shot stream after alternate dispatch", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    await expect(fetchUpstream()("https://api.example/large", {
      method: "PUT", headers: new Headers({ "content-length": String(33 * 1024 * 1024) }), body,
    })).rejects.toThrow("socket closed after dispatch");
    expect(primary).not.toHaveBeenCalled();
  });

  it("allows a replayable POST only for a proven pre-send connection failure", async () => {
    alternate.mockRejectedValue(new Error("websocket did not open"));
    const response = await fetchUpstream()("https://api.example/write", { method: "POST", headers: new Headers(), body: "change" });
    expect(await response.text()).toBe("primary");
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("keeps missing-endpoint fallback before any alternate request was attempted", async () => {
    vi.mocked(transport.altConfigured).mockReturnValue(false);
    await fetchUpstream()("https://api.example/write", { method: "POST", headers: new Headers(), body: "change" });
    expect(alternate).not.toHaveBeenCalled();
    expect(primary).toHaveBeenCalledTimes(1);
  });
});
