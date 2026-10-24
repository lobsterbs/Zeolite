import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorVirtual, applyAnchorShim } from "../bootstrap/anchorshim";

/* #418: query-shape committed routes carry the handle in the
   zlNavh query param with the real pathname untouched, so the
   route-shape detector must classify them or the scan never asks
   the worker oracle and the opaque engine route leaks onto the
   page surface (Startpage breadcrumbs). The worker decode stays
   the judge: a real-site path that false-positives decodes to
   null and memoizes negative. */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anchor shim query-shape routes (#418)", () => {
  it("asks the worker about zlNavh query routes in both forms, not about plain hrefs", async () => {
    const LOC = "https://engine.host/search?q=1&zlNavh=initialtoken1234";
    const ENGINE = "https://engine.host";
    const dest = "https://real.site/page";
    const token = "AfhHzGwm0S7HzQm7oCo2";
    const attr = "/search?q=1&zlNavh=" + token;
    const abs = ENGINE + attr;
    const elemProto: Record<string, any> = {
      getAttribute(this: any, n: string) {
        return (this._attrs ?? {})[n] ?? null;
      },
    };
    const qEl = Object.create(elemProto) as Record<string, any>;
    qEl._attrs = { href: attr };
    const plainEl = Object.create(elemProto) as Record<string, any>;
    plainEl._attrs = { href: "/search?q=1" };
    const sent: Array<{ type: string; routes: string[] }> = [];
    const ports: Array<{ postMessage: (p: unknown) => void }> = [];
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {
          postMessage: (
            m: { type: string; routes: string[] },
            t: Array<{ postMessage: (p: unknown) => void }>,
          ) => {
            sent.push(m);
            ports.push(t[0]);
          },
        },
      },
    });
    const w: Record<string, any> = {
      document: { readyState: "complete", querySelectorAll: () => [qEl, plainEl] },
      location: { href: LOC },
    };
    applyAnchorShim(w);
    /* pending read: the memo is empty */
    expect(anchorVirtual(attr)).toBeUndefined();
    for (let i = 0; i < 300 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("zl:decodeRoutes");
    /* the query route was asked in both its forms; the plain
       site href was not */
    expect(sent[0].routes).toEqual([attr, abs]);
    ports[0].postMessage({ ok: true, dests: [dest, dest] });
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    expect(anchorVirtual(attr)).toBe(dest);
    expect(anchorVirtual(abs)).toBe(dest);
  });
});
