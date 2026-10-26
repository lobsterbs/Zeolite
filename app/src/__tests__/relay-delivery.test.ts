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
