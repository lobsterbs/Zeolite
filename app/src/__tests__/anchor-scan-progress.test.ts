import { afterEach, describe, expect, it, vi } from "vitest";

/* #488: the real page shim with a deterministic controller/DOM fixture.
   A bounded 512-entry memo MUST NOT restart the scan from the prefix
   when a longer document evicts its first decoded routes. */
const ENGINE = "https://engine.example";
class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close(): void {}
  postMessage(_message: unknown): void {}
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port2.postMessage = (message: unknown) => {
      queueMicrotask(() => this.port1.onmessage?.({ data: message } as MessageEvent));
    };
  }
}
function route(i: number, relative: boolean): string {
  const path = "/j/" + i.toString(36).padStart(20, "a");
  return relative ? path : ENGINE + path;
}

async function fixture(count: number, relative: boolean) {
  vi.resetModules();
  vi.stubGlobal("MessageChannel", Channel);
  const proto = {
    getAttribute(this: { attrs: Record<string, string> }, n: string) {
      return this.attrs[n] ?? null;
    },
  };
  const nodes = Array.from({ length: count }, (_, i) =>
    Object.assign(Object.create(proto), { tagName: "A", attrs: { href: route(i, relative) } }),
  ) as Array<{ getAttribute(n: string): string | null; attrs: Record<string, string> }>;
  const dest = (s: string) => "https://real.example/" + s.split("/").at(-1);
  const batches: string[][] = [];
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage(req: { type: string; routes: string[] }, ports: Port[]) {
          expect(req.type).toBe("zl:decodeRoutes");
          batches.push(req.routes);
          queueMicrotask(() => ports[0].postMessage({
            ok: true,
            dests: req.routes.map(dest),
          }));
        },
      },
    },
  });
  let mutation: (() => void) | null = null;
  let observed: Record<string, unknown> | null = null;
  class MutationObserverFake {
    constructor(fn: () => void) { mutation = fn; }
    observe(_el: unknown, options: Record<string, unknown>) { observed = options; }
  }
  const w = {
    Element: { prototype: proto },
    document: {
      readyState: "complete", documentElement: {},
      querySelectorAll: () => nodes,
    },
    location: { href: ENGINE + "/j/current" },
    MutationObserver: MutationObserverFake,
  };
  const { applyAnchorShim, anchorVirtual } = await import("../bootstrap/anchorshim");
  applyAnchorShim(w);
  return { nodes, batches, dest, get mutation() { return mutation; }, get observed() { return observed; }, anchorVirtual };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("anchor scan cursor convergence (#488)", () => {
  for (const [count, relative] of [[600, false], [300, true]] as const) {
    it(`reaches the final item, then quiesces for ${count} ${relative ? "route pairs" : "absolute routes"}`, async () => {
      vi.useFakeTimers();
      const t = await fixture(count, relative);
      await vi.advanceTimersByTimeAsync(4500);
      const last = t.nodes.at(-1)!;
      expect(last.getAttribute("href")).toBe(t.dest(route(count - 1, relative)));
      expect(t.batches.length).toBeGreaterThan(4);
      expect(t.batches.length).toBeLessThan(30);
      const atRest = t.batches.length;
      await vi.advanceTimersByTimeAsync(2500);
      expect(t.batches.length).toBe(atRest);
      expect(t.observed).toMatchObject({ attributes: true, attributeFilter: ["href"] });
    });
  }

  it("revisits a changed href without restarting old decoded prefixes", async () => {
    vi.useFakeTimers();
    const t = await fixture(100, true);
    await vi.advanceTimersByTimeAsync(1500);
    const oldBatches = t.batches.length;
    const next = route(9999, true);
    t.nodes[40].attrs.href = next;
    t.mutation?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.nodes[40].getAttribute("href")).toBe(t.dest(next));
    expect(t.batches.length).toBeGreaterThan(oldBatches);
    const quiet = t.batches.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.batches.length).toBe(quiet);
  });

  it("resolves an evicted route on explicit getter access without a scan storm", async () => {
    vi.useFakeTimers();
    const t = await fixture(600, false);
    await vi.advanceTimersByTimeAsync(4500);
    const oldRoute = route(0, false);
    const prior = t.batches.length;
    expect(t.anchorVirtual(oldRoute)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.batches.length).toBe(prior + 1);
    expect(t.anchorVirtual(oldRoute)).toBe(t.dest(oldRoute));
  });
});
