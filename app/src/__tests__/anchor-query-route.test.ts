import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAnchorShim } from "../bootstrap/anchorshim";

afterEach(() => vi.unstubAllGlobals());

describe("query-form anchor reads (#418)", () => {
  it("decodes query-shape anchor routes in relative and absolute form", async () => {
    const LOC = "https://query.engine.test/?zlNavh=entry";
    const attrs = ["/result?zlNavh=query-route-a", "/other?q=term&zlNavh=query-route-b"];
    const dests = ["https://target.test/result", "https://target.test/other?q=term"];
    const elemProto: Record<string, any> = {
      getAttribute(this: any, n: string) { return this._attrs[n] ?? null; },
    };
    const nodes = attrs.map((href) => Object.assign(Object.create(elemProto), { tagName: "A", _attrs: { href } }));
    const sent: string[][] = [];
    vi.stubGlobal("navigator", { serviceWorker: { controller: {
      postMessage(m: { routes: string[] }, ports: MessagePort[]) {
        sent.push(m.routes);
        ports[0].postMessage({ ok: true, dests: m.routes.map((r) => {
          const u = new URL(r, LOC);
          return dests[u.pathname === "/result" ? 0 : 1];
        }) });
      },
    } } });
    applyAnchorShim({
      document: { readyState: "complete", querySelectorAll: () => nodes },
      location: { href: LOC }, Element: { prototype: elemProto },
    });
    for (let i = 0; i < 60 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(attrs.flatMap((a) => [a, new URL(a, LOC).href]));
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(nodes.map((n) => n.getAttribute("href"))).toEqual(dests);
  });
});
