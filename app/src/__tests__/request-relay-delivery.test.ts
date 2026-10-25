import { afterEach, describe, expect, it, vi } from "vitest";
class Port {
  onmessage: ((e: MessageEvent) => void) | null = null;
  sent: Array<{ type: string; rid: number }> = [];
  postMessage(m: { type: string; rid: number }) { this.sent.push(m); }
  reply(m: unknown) { this.onmessage?.(new MessageEvent("message", { data: m })); }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("relay policy delivery contract (#442)", () => {
  for (const method of ["POST", "PATCH", "GET"]) {
    it(`${method} ${method === "GET" ? "may" : "must not"} fall back after dispatched relay failure`, async () => {
      vi.resetModules();
      const { compilePolicy } = await import("../policy");
      const { recoveryUpstream } = await import("../request");
      const { relayRegister } = await import("../relayfetch");
      const { wispTransport } = await import("../transport");
      const primary = vi.spyOn(wispTransport, "fetch").mockResolvedValue(new Response("primary"));
      const port = new Port(); relayRegister(port as unknown as MessagePort);
      const fetch = recoveryUpstream(compilePolicy('rule "relay" { route "relay" }'), "fetch", "relay-test");
      const result = fetch("https://api.example/write", { method, headers: new Headers() })
        .then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
      for (let i = 0; i < 1000 && !port.sent.length; i++) await Promise.resolve();
      expect(port.sent[0].type).toBe("zl:fetchRelay");
      port.reply({ type: "zl:relayError", rid: port.sent[0].rid, error: "lost after dispatch" });
      const out = await result;
      if (method === "GET") {
        expect(await out.value?.text()).toBe("primary"); expect(primary).toHaveBeenCalledTimes(1);
      } else {
        expect((out.error as Error).name).toBe("RelayDeliveryUnknownError");
        expect(primary).not.toHaveBeenCalled();
      }
    });
  }
});
