import { afterEach, describe, expect, it, vi } from "vitest";

/* Exercise the production KDL loader branches; Doctor only reads the
   passive status accessors, so it cannot trigger an extra file fetch. */
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

type Loader = {
  load: () => Promise<unknown>;
  state: () => string;
};

async function loader(which: "policy" | "rules" | "siteconfig"): Promise<Loader> {
  vi.resetModules();
  if (which === "policy") {
    const p = await import("../policy");
    return { load: p.loadPolicy, state: p.policyDoctorState };
  }
  if (which === "rules") {
    const p = await import("../rules");
    return { load: p.loadRules, state: p.rulesDoctorState };
  }
  const p = await import("../siteconfig");
  return { load: p.siteRules, state: p.siteconfigDoctorState };
}

describe("read-only KDL source diagnostics (#495)", () => {
  for (const which of ["policy", "rules", "siteconfig"] as const) {
    it(`reports unobserved/loaded/missing/invalid/unavailable for ${which}`, async () => {
      const read = async (response: () => Promise<Response>, expected: string) => {
        const mockFetch = vi.fn(response);
        vi.stubGlobal("fetch", mockFetch);
        const p = await loader(which);
        expect(p.state()).toBe("not-loaded");
        // Pure passive reads do not fetch anything.
        expect(mockFetch).not.toHaveBeenCalled();
        await p.load();
        expect(p.state()).toBe(expected);
      };
      await read(async () => new Response("", { status: 200 }), "loaded");
      await read(async () => new Response(null, { status: 404 }), "missing");
      await read(async () => new Response('site "broken" {', { status: 200 }), "invalid");
      await read(async () => { throw new TypeError("dns failure"); }, "unavailable");
      vi.unstubAllGlobals();
    });
  }
});
