/* #415: stale peer failures must not invalidate a replacement. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  primaryResets: 0, altResets: 0, inits: 0,
  pending: [] as Array<{ resolve: (r: Response) => void; reject: (e: Error) => void }>,
}));
const fetcher = () => new Promise<Response>((resolve, reject) => h.pending.push({ resolve, reject }));
vi.mock("../libcurl-transport-vendored", () => ({
  init: async () => { h.inits++; }, fetch: () => fetcher(), altFetch: () => fetcher(),
  reset: () => { h.primaryResets++; }, altReset: () => { h.altResets++; },
  isConnectClassError: () => true, setEngine: () => {}, currentEngine: () => "libcurl",
  openWebSocket: () => {}, altRegister: () => {}, altConfigured: () => false, altEndpoint: () => null,
}));
const turn = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); h.primaryResets = h.altResets = h.inits = 0; h.pending = [];
});
describe("shared connection recovery (#415)", () => {
  for (const alternate of [false, true]) {
    it(`coalesces late failures on the ${alternate ? "alternate" : "primary"} Wisp connection`, async () => {
      const m = await import("../transport"); m.transportResetForTests(500);
      const fetch = alternate ? m.altWispFetch : m.wispTransport.fetch;
      const requests = [fetch("https://a.example/1"), fetch("https://a.example/2"), fetch("https://a.example/3")];
      await turn(); expect(h.pending).toHaveLength(3);
      h.pending[0].reject(new Error("websocket did not open"));
      await turn(); expect(h.pending).toHaveLength(4);
      h.pending[1].reject(new Error("websocket did not open"));
      h.pending[2].reject(new Error("websocket did not open"));
      await turn(); expect(h.pending).toHaveLength(6);
      expect(alternate ? h.altResets : h.primaryResets).toBe(1);
      if (!alternate) expect(h.inits).toBe(2);
      for (const p of h.pending.slice(3)) p.resolve(new Response("recovered"));
      expect(await Promise.all(requests.map(async r => (await r).text()))).toEqual(["recovered", "recovered", "recovered"]);
      const later = fetch("https://a.example/4"); await turn();
      h.pending[6].reject(new Error("websocket did not open")); await turn();
      expect(alternate ? h.altResets : h.primaryResets).toBe(2);
      h.pending[7].resolve(new Response("new recovery"));
      expect(await (await later).text()).toBe("new recovery");
    });
  }
});
