import { describe, expect, it } from "vitest";
import { relayFetch, relayRegister, RELAY_CREDIT_BYTES } from "../relayfetch";

/* #470: a crediting embedder (credits: 1 on zl:relayRegister) receives
   an up-front byte grant plus a grant-back per drained chunk so it can
   pace its reads. A legacy registration never sees a credit frame. */

class Port {
  sent: Array<{ type: string; rid: number; bytes?: number }> = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(m: { type: string; rid: number; bytes?: number }) {
    this.sent.push(m);
  }
  reply(m: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: m }));
  }
}
function reg(credits?: unknown) {
  const p = new Port();
  relayRegister(p as unknown as MessagePort, credits);
  return p;
}
const creditsOf = (p: Port) => p.sent.filter((m) => m.type === "zl:relayCredit");

async function deliver(p: Port, sizes: number[]) {
  const pending = relayFetch("https://api.example/read", { method: "GET", headers: new Headers() }, "t");
  const rid = p.sent[0].rid;
  p.reply({ type: "zl:relayHead", rid, status: 200, statusText: "", headers: [] });
  for (const n of sizes) p.reply({ type: "zl:relayChunk", rid, bytes: new Uint8Array(n) });
  p.reply({ type: "zl:relayEnd", rid });
  const resp = await pending;
  if (!resp) throw new Error("expected a relayed response");
  expect((await resp.text()).length).toBe(sizes.reduce((a, b) => a + b, 0));
}

describe("relay response backpressure (#470)", () => {
  it("never sends credit frames to a legacy embedder", async () => {
    const port = reg();
    await deliver(port, [3, 5]);
    expect(creditsOf(port)).toEqual([]);
  });

  it("grants a crediting embedder up front and back per drained chunk", async () => {
    const port = reg(1);
    const pending = relayFetch("https://api.example/big", { method: "GET", headers: new Headers() }, "t");
    const rid = port.sent[0].rid;
    expect(port.sent[1]).toEqual({ type: "zl:relayCredit", rid, bytes: RELAY_CREDIT_BYTES });
    port.reply({ type: "zl:relayHead", rid, status: 200, statusText: "", headers: [] });
    port.reply({ type: "zl:relayChunk", rid, bytes: new Uint8Array(1024) });
    port.reply({ type: "zl:relayChunk", rid, bytes: new Uint8Array(2048) });
    port.reply({ type: "zl:relayEnd", rid });
    const resp = await pending;
    if (!resp) throw new Error("expected a relayed response");
    expect((await resp.text()).length).toBe(1024 + 2048);
    expect(creditsOf(port).map((m) => m.bytes)).toEqual([RELAY_CREDIT_BYTES, 1024, 2048]);
  });

  it("treats any credits value other than 1 as legacy", async () => {
    const port = reg(2);
    await deliver(port, [4]);
    expect(creditsOf(port)).toEqual([]);
  });
  it("keeps each stream's negotiated credits across re-registration", async () => {
    const p = reg(1);
    const pending = relayFetch("https://api.example/read", { method: "GET", headers: new Headers() }, "t");
    const rid = p.sent[0].rid;
    reg();
    p.reply({ type: "zl:relayHead", rid, status: 200, statusText: "", headers: [] });
    p.reply({ type: "zl:relayChunk", rid, bytes: new Uint8Array(8) });
    p.reply({ type: "zl:relayEnd", rid });
    expect(await (await pending)!.text()).toHaveLength(8);
    expect(creditsOf(p).map(m => m.bytes)).toEqual([RELAY_CREDIT_BYTES, 8]);
  });

  it("cancels an overflowing legacy response instead of retaining unlimited bytes", async () => {
    const p = reg();
    const pending = relayFetch("https://api.example/read", { method: "POST", headers: new Headers() }, "t");
    const rid = p.sent[0].rid;
    p.reply({ type: "zl:relayChunk", rid, bytes: new Uint8Array(RELAY_CREDIT_BYTES * 2 + 1) });
    await expect(pending).rejects.toThrow("queue limit exceeded");
    expect(p.sent.filter(m => m.type === "zl:relayCancel")).toHaveLength(1);
  });

  it.each([204, 205, 304])("releases bodyless %s responses without waiting for a body reader", async status => {
    const p = reg();
    const pending = relayFetch("https://api.example/read", { method: "GET", headers: new Headers() }, "t");
    const rid = p.sent[0].rid;
    p.reply({ type: "zl:relayHead", rid, status, statusText: "", headers: [] });
    const response = await pending;
    expect(response!.body).toBeNull();
    expect(p.sent.filter(m => m.type === "zl:relayCancel")).toHaveLength(1);
  });

});
