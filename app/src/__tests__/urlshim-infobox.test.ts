/* #510: Brave's SERP infobox website row renders
   truncate40(new URL(infobox.website_url).hostname minus www)
   from a hydration data island whose URL literals the rewriter
   minted as engine routes, so the parse surfaced the engine host
   on the fact card instead of telegram.org. The seam: the
   document scan harvests route-shaped literals from inline
   script text, the worker decode fills the memo before the page
   reads, and the wrapped URL constructor serves the decoded
   virtual destination - a parse miss keeps the native route
   (the anchorshim race), non-route strings parse untouched, and
   engine internals keep the captured NativeURL. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAnchorShim, applyUrlShim, urlVirtual } from "../bootstrap/anchorshim";
import { swShimRegister } from "../swshim";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubController(sent: unknown[], ports: unknown[]): void {
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: {
        postMessage: (m: { type: string; routes: string[] }, t: unknown[]) => {
          sent.push(m);
          ports.push(t[0]);
        },
      },
    },
  });
}

async function settle(pred: () => boolean, ms = 15, spins = 400): Promise<boolean> {
  for (let i = 0; i < spins; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return pred();
}

describe("URL parse seam (#510 Brave infobox website row)", () => {
  it("serves the decoded destination for a route harvested from an inline script data island", async () => {
    const sent: Array<{ type: string; routes: string[] }> = [];
    const ports: Array<{ postMessage: (p: unknown) => void }> = [];
    stubController(sent, ports);
    const route = "https://engine.host/zl/AbCdEfGh12345678XyZq";
    const script = {
      textContent:
        '(function(a,b){return {type:"data",data:{infobox:{title:"Telegram",website_url:"' +
        route +
        '",long_desc:"x"}}}})',
    };
    const w: Record<string, any> = {
      document: {
        readyState: "complete",
        querySelectorAll: (sel: string) => (sel === "script:not([src])" ? [script] : []),
      },
      location: { href: "https://engine.host/search?q=telegram" },
      URL,
    };
    applyAnchorShim(w);
    applyUrlShim(w);
    /* the scan harvests the island literal and asks the worker */
    expect(await settle(() => sent.length === 1)).toBe(true);
    expect(sent[0].type).toBe("zl:decodeRoutes");
    expect(sent[0].routes).toEqual([route]);
    /* a read before the reply lands keeps the native route (the
       anchorshim race, not a hang) */
    expect(new (w.URL as new (i: string) => URL)(route).hostname).toBe("engine.host");
    ports[0].postMessage({ ok: true, dests: ["https://telegram.org/"] });
    expect(await settle(() => urlVirtual(route) === "https://telegram.org/")).toBe(true);
    /* the fact-card derivation: new URL(website_url).hostname */
    const u = new (w.URL as new (i: string) => URL)(route);
    expect(u.hostname).toBe("telegram.org");
    expect(u.href).toBe("https://telegram.org/");
    expect(u).toBeInstanceOf(URL);
    expect((w.URL as { prototype: unknown }).prototype).toBe(URL.prototype);
  });

  it("keeps the native parse on a miss and still asks the worker", async () => {
    const sent: Array<{ type: string; routes: string[] }> = [];
    const ports: Array<{ postMessage: (p: unknown) => void }> = [];
    stubController(sent, ports);
    const route = "https://engine.host/zl/Qq9zXwVv87654321AbCdEf";
    const w: Record<string, any> = {
      document: { readyState: "complete", querySelectorAll: () => [] },
      location: { href: "https://engine.host/x" },
      URL,
    };
    applyAnchorShim(w);
    applyUrlShim(w);
    /* a data route the scan never saw: the first parse is native */
    expect(new (w.URL as new (i: string) => URL)(route).href).toBe(route);
    expect(await settle(() => sent.length >= 1)).toBe(true);
    ports[ports.length - 1].postMessage({ ok: true, dests: ["https://web.telegram.org/"] });
    expect(
      await settle(() => new (w.URL as new (i: string) => URL)(route).hostname === "web.telegram.org"),
    ).toBe(true);
  });

  it("leaves non-route strings, statics and double installs native", async () => {
    const sent: Array<{ type: string; routes: string[] }> = [];
    const ports: Array<{ postMessage: (p: unknown) => void }> = [];
    stubController(sent, ports);
    const w: Record<string, any> = {
      document: { readyState: "complete", querySelectorAll: () => [] },
      location: { href: "https://engine.host/x" },
      URL,
    };
    applyAnchorShim(w);
    applyUrlShim(w);
    const u = new (w.URL as new (i: string) => URL)("https://plain.example/p?a=1");
    expect(u.hostname).toBe("plain.example");
    const rel = new (w.URL as new (i: string, b?: string) => URL)("/y/z", "https://base.example/");
    expect(rel.href).toBe("https://base.example/y/z");
    /* a twice-guarded realm is not wrapped again */
    expect((w.URL as { __zlUrlWrap?: boolean }).__zlUrlWrap).toBe(true);
    applyUrlShim(w);
    expect((w.URL as { __zlUrlWrap?: boolean }).__zlUrlWrap).toBe(true);
  });

  it("keeps the swshim register native: a memoized script route still registers against the page route (#510 follow-up)", async () => {
    const sent: Array<{ type: string; routes: string[] }> = [];
    const ports: Array<{ postMessage: (p: unknown) => void }> = [];
    stubController(sent, ports);
    /* the page route never joins the memo (no anchor or island
       carries it), the script route does - the CI shape that threw
       TypeError Origin when the shim parsed through the seam */
    const pageRoute = "https://engine.host/zl/PageRouteToken1XyZq";
    const swRoute = "https://engine.host/zl/SwScriptRoute01XyZq";
    const script = { textContent: "x=" + JSON.stringify(swRoute) };
    const w: Record<string, any> = {
      document: {
        readyState: "complete",
        querySelectorAll: (sel: string) => (sel === "script:not([src])" ? [script] : []),
      },
      location: { href: pageRoute },
      URL,
    };
    applyAnchorShim(w);
    applyUrlShim(w);
    expect(await settle(() => sent.length === 1)).toBe(true);
    ports[0].postMessage({ ok: true, dests: ["https://site.example/sw.js"] });
    expect(await settle(() => urlVirtual(swRoute) !== undefined)).toBe(true);
    const rec: { v: string | null } = { v: null };
    const store = {
      get: () => rec.v,
      set: (v: string) => {
        rec.v = v;
      },
      clear: () => {
        rec.v = null;
      },
    };
    const reg = swShimRegister(store, pageRoute, swRoute);
    expect(reg.installing).not.toBeNull();
    /* Registrations persist as an array of per-scope records. */
    const stored = JSON.parse(String(rec.v)) as Array<{ scriptURL: string; scope: string }>;
    const rec0 = stored[stored.length - 1];
    expect(rec0.scriptURL).toBe(swRoute);
    expect(rec0.scope.startsWith("https://engine.host/")).toBe(true);
  });
});
