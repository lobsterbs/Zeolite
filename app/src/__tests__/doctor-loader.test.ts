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

describe("siteconfig 5xx transient retry (#627)", () => {
  it("forgets the memo after a 5xx so the next call retries", async () => {
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 503 })
        : new Response('site "a.example" { inject "/a.js" }', { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);
    const p = await loader("siteconfig");
    expect(await p.load()).toEqual({});
    expect(p.state()).toBe("unavailable");
    const rules = (await p.load()) as Record<string, unknown>;
    expect(Object.keys(rules)).toEqual(["a.example"]);
    expect(p.state()).toBe("loaded");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a 404 memoized so a missing file costs one fetch", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", mockFetch);
    const p = await loader("siteconfig");
    await p.load();
    await p.load();
    expect(p.state()).toBe("missing");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
