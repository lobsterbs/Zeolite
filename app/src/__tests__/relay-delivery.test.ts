import { afterEach, describe, expect, it, vi } from "vitest";
import { relayFetch, relayRegister, RELAY_HEADER_DEADLINE_MS, RELAY_UPLOAD_HEADER_DEADLINE_MS, RelayDeliveryUnknownError } from "../relayfetch";
import { deliveryStateOf } from "../delivery";
class Port {
  sent: Array<{ type: string; rid: number }> = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(m: { type: string; rid: number }) { this.sent.push(m); }
  reply(m: unknown) { this.onmessage?.(new MessageEvent("message", { data: m })); }
}
function reg() { const p = new Port(); relayRegister(p as unknown as MessagePort); return p; }
const outcome = <T>(p: Promise<T>) => p.then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
afterEach(() => vi.useRealTimers());
describe("relay delivery safety (#442)", () => {
  it("fails a dispatched POST honestly on deadline instead of returning fallback null", async () => {
    vi.useFakeTimers(); const port = reg();
    const pending = outcome(relayFetch("https://api.example/write", { method: "POST", headers: new Headers(), body: "x=1" }, "post-timeout"));
    await vi.advanceTimersByTimeAsync(RELAY_HEADER_DEADLINE_MS + 1);
    const r = await pending;
    expect(r.error).toBeInstanceOf(RelayDeliveryUnknownError);
    expect(String(r.error)).toContain("request not retried");
    expect(port.sent.map(m => m.type)).toEqual(["zl:fetchRelay", "zl:relayCancel"]);
  });
  it("does not permit fallback when a dispatched PATCH reports a relay failure", async () => {
    const port = reg();
    const pending = outcome(relayFetch("https://api.example/write", { method: "PATCH", headers: new Headers(), body: "{}" }, "patch-error"));
    port.reply({ type: "zl:relayError", rid: port.sent[0].rid, error: "connection lost" });
    const err = (await pending).error as RelayDeliveryUnknownError;
    expect(err).toBeInstanceOf(RelayDeliveryUnknownError);
    expect(deliveryStateOf(err)).toBe("delivery-unknown");
    expect(err.transport).toBe("relay");
  });
  it("contains a synchronous relay port failure without replaying POST", async () => {
    const port = reg();
    const spy = vi.spyOn(port, "postMessage").mockImplementation(() => {
      throw new Error("MessagePort has been closed");
    });
    const result = await outcome(relayFetch(
      "https://api.example/create",
      { method: "POST", headers: new Headers(), body: "value=1" },
      "sync-relay-error",
    ));
    expect(result.error).toBeInstanceOf(RelayDeliveryUnknownError);
    expect(deliveryStateOf(result.error)).toBe("delivery-unknown");
    expect((result.error as RelayDeliveryUnknownError).transport).toBe("relay");
    expect(spy).toHaveBeenCalled();
  });

  it("allows a GET fallback when the relay channel throws synchronously", async () => {
    const port = reg();
    vi.spyOn(port, "postMessage").mockImplementation(() => {
      throw new Error("closed");
    });
    expect(await relayFetch(
      "https://api.example/read",
      { method: "GET", headers: new Headers() },
      "sync-get-error",
    )).toBeNull();
  });

  it("keeps idempotent GET deadline fallback and cancellation", async () => {
    vi.useFakeTimers(); const port = reg();
    const pending = relayFetch("https://api.example/read", { method: "GET", headers: new Headers() }, "get-timeout");
    await vi.advanceTimersByTimeAsync(RELAY_HEADER_DEADLINE_MS + 1);
    expect(await pending).toBeNull();
    expect(port.sent.some(m => m.type === "zl:relayCancel")).toBe(true);
  });
  it("allows a multipart upload to answer after the ordinary header bound", async () => {
    vi.useFakeTimers(); const port = reg();
    const pending = relayFetch("https://files.example/upload", { method: "POST", headers: new Headers({ "content-type": "multipart/form-data; boundary=x" }), body: new ArrayBuffer(8) }, "upload");
    let settled = false; pending.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(RELAY_HEADER_DEADLINE_MS + 1);
    expect(settled).toBe(false);
    port.reply({ type: "zl:relayHead", rid: port.sent[0].rid, status: 204, statusText: "", headers: [] });
    port.reply({ type: "zl:relayEnd", rid: port.sent[0].rid });
    expect((await pending)?.status).toBe(204);
    expect(port.sent.some(m => m.type === "zl:relayCancel")).toBe(true);
  });
  it("still bounds a large upload and preserves caller cancellation", async () => {
    vi.useFakeTimers(); const port = reg();
    const pending = outcome(relayFetch("https://files.example/upload", { method: "POST", headers: new Headers(), body: new ArrayBuffer(512 * 1024 + 1) }, "large"));
    await vi.advanceTimersByTimeAsync(RELAY_UPLOAD_HEADER_DEADLINE_MS + 1);
    expect((await pending).error).toBeInstanceOf(RelayDeliveryUnknownError);
    const ctl = new AbortController();
    const aborted = outcome(relayFetch("https://files.example/upload", { method: "POST", headers: new Headers(), body: "x", signal: ctl.signal }, "abort"));
    ctl.abort(); expect(((await aborted).error as Error).name).toBe("AbortError");
    expect(port.sent.filter(m => m.type === "zl:relayCancel")).toHaveLength(2);
  });
});

describe("relay evidence and failure cleanup (#454)", () => {
  it("reports unknown delivery and removes its waiter when dispatch postMessage throws", async () => {
    const { relayFetchResult, relayPendingCount } = await import("../relayfetch");
    relayRegister({ postMessage() { throw new Error("dead port"); }, onmessage: null } as unknown as MessagePort);
    const result = await relayFetchResult("https://api.example/write", { method: "POST", headers: new Headers(), body: "x" }, "port-failure");
    expect(result.state).toBe("delivery-unknown");
    expect(relayPendingCount()).toBe(0);
  });
  it("cleans up and cancels when malformed response headers cannot construct a Response", async () => {
    const { relayFetchResult, relayPendingCount } = await import("../relayfetch");
    const port = reg();
    const pending = relayFetchResult("https://api.example/write", { method: "POST", headers: new Headers() }, "bad-header");
    port.reply({ type: "zl:relayHead", rid: port.sent[0].rid, status: 200, statusText: "", headers: [["bad\nname", "x"]] });
    expect((await pending).state).toBe("delivery-unknown");
    expect(relayPendingCount()).toBe(0);
    expect(port.sent.some(m => m.type === "zl:relayCancel")).toBe(true);
  });
  it("records delivery response only after real headers and keeps the original response contract", async () => {
    const { relayFetchResult, relayPendingCount } = await import("../relayfetch");
    const port = reg();
    const pending = relayFetchResult("https://api.example/write", { method: "POST", headers: new Headers() }, "accepted");
    port.reply({ type: "zl:relayHead", rid: port.sent[0].rid, status: 204, statusText: "", headers: [] });
    const result = await pending;
    expect(result.state).toBe("delivered-response");
    expect(result.state === "delivered-response" && result.response.status).toBe(204);
    expect(relayPendingCount()).toBe(0);
  });
  it("a throwing cancel port cannot strand an aborted reader", async () => {
    const { relayPendingCount } = await import("../relayfetch");
    const port = reg();
    const ctl = new AbortController();
    const pending = outcome(relayFetch("https://api.example/write", { method: "POST", headers: new Headers(), signal: ctl.signal }, "cancel-failure"));
    port.postMessage = () => { throw new Error("closed"); };
    ctl.abort();
    expect(((await pending).error as Error).name).toBe("AbortError");
    expect(relayPendingCount()).toBe(0);
  });
  it("rejects a malformed chunk without leaving the pending relay alive", async () => {
    const { relayFetchResult, relayPendingCount } = await import("../relayfetch");
    const port = reg();
    const pending = relayFetchResult("https://api.example/write", { method: "POST", headers: new Headers() }, "bad-chunk");
    port.reply({ type: "zl:relayChunk", rid: port.sent[0].rid, bytes: null });
    const result = await pending;
    expect(result.state).toBe("delivery-unknown");
    expect(relayPendingCount()).toBe(0);
    expect(port.sent.some(m => m.type === "zl:relayCancel")).toBe(true);
  });

  it("cleans up when a credit acknowledgment port fails during body consumption", async () => {
    const { relayPendingCount } = await import("../relayfetch");
    const port = new Port();
    relayRegister(port as unknown as MessagePort, 1);
    const pending = relayFetch("https://api.example/read", { method: "GET", headers: new Headers() }, "credit-failure");
    const rid = port.sent[0].rid;
    port.reply({ type: "zl:relayHead", rid, status: 200, statusText: "", headers: [] });
    const response = await pending;
    const post = port.postMessage.bind(port);
    port.postMessage = m => { if (m.type === "zl:relayCredit") throw new Error("credit port closed"); post(m); };
    port.reply({ type: "zl:relayChunk", rid, bytes: new Uint8Array([1]) });
    await expect(response!.text()).rejects.toThrow("credit port closed");
    expect(relayPendingCount()).toBe(0);
    expect(port.sent.some(m => m.type === "zl:relayCancel")).toBe(true);
  });

  it("preserves pre-aborted cancellation even when the relay cannot carry the body", async () => {
    reg();
    const controller = new AbortController(); controller.abort();
    await expect(relayFetch("https://api.example/write", {
      method: "POST", headers: new Headers(), body: new ReadableStream(), signal: controller.signal,
    }, "pre-aborted-stream")).rejects.toMatchObject({ name: "AbortError" });
  });

});
