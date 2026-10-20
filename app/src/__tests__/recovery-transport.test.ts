import { afterEach, describe, expect, it, vi } from "vitest";
import requestSrc from "../request.ts?raw";

/* #290 residual (2026-10-20 sorry-page report): recovery candidates
   are upstream fetches and must ride the same relay/wisp transport
   decision as the page's own subresources. A lambda over the raw
   wisp client died on relay-only embedders (their password-authed
   /wisp/ endpoint) and took the flag-surgery and flat-asset retry
   paths down with it: the google sorry page recovered nothing and
   fanned connect errors into the diag ring. */

class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  deliver(m: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: m }));
  }
}

describe("recovery candidate transport (#290 residual)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("wires both recovery seams through recoveryUpstream, not the raw wisp client", () => {
    expect(requestSrc).toContain("recoveryUpstream(policy, rtype, traceId)");
    expect(requestSrc).not.toContain("(u2, init2) => wispTransport.fetch(u2, init2, traceId)");
  });

  it("routes a relay-rule candidate through the embedder relay and never the wisp client", async () => {
    vi.resetModules();
    const { compilePolicy } = await import("../policy");
    const { recoveryUpstream } = await import("../request");
    const { relayRegister } = await import("../relayfetch");
    const { wispTransport } = await import("../transport");
    const wisp = vi.spyOn(wispTransport, "fetch");
    const port = new FakePort();
    relayRegister(port as unknown as MessagePort);
    const fetchUpstream = recoveryUpstream(compilePolicy('rule "rr" { route "relay" }'), "script", "t-rec1");
    const respP = fetchUpstream("https://cdn.example/x.js", { method: "GET", headers: new Headers() });
    for (let i = 0; i < 1000 && !port.posted.length; i++) await Promise.resolve();
    const sent = port.posted[0] as { type: string; rid: number };
    expect(sent.type).toBe("zl:fetchRelay");
    port.deliver({ type: "zl:relayHead", rid: sent.rid, status: 200, statusText: "", headers: [["content-type", "application/javascript"]] });
    port.deliver({ type: "zl:relayEnd", rid: sent.rid });
    const resp = await respP;
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("");
    expect(wisp).not.toHaveBeenCalled();
  });

  it("falls back honestly to the wisp client when no relay channel answers", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const { compilePolicy } = await import("../policy");
    const { recoveryUpstream } = await import("../request");
    const { wispTransport } = await import("../transport");
    const wisp = vi.spyOn(wispTransport, "fetch").mockResolvedValue(new Response("wisp", { status: 200 }));
    const fetchUpstream = recoveryUpstream(compilePolicy('rule "rr" { route "relay" }'), "script", "t-rec2");
    const respP = fetchUpstream("https://cdn.example/x.js", { method: "GET", headers: new Headers() });
    await vi.advanceTimersByTimeAsync(3000);
    const resp = await respP;
    expect(await resp.text()).toBe("wisp");
    expect(wisp).toHaveBeenCalledTimes(1);
  });
});
