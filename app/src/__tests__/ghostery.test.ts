/* Ghostery adapter seams (#363): the list-fetch URL guard and
   the applyRules integration. The filter engine is mocked; only the
   adapter's own logic runs. */

import { describe, expect, it, vi } from "vitest";

const cap = vi.hoisted(() => ({
  listFetch: null as typeof fetch | null,
  inits: [] as unknown[],
}));

vi.mock("@ghostery/adblocker", () => ({
  FiltersEngine: {
    fromPrebuiltAdsAndTracking: async (f: typeof fetch) => {
      cap.listFetch = f;
      return {
        match: () => ({
          match: true,
          filter: { getHostname: () => "ads.example" },
          redirect: { body: "/* blocked */", contentType: "application/javascript" },
        }),
      };
    },
  },
  Request: { fromRawDetails: (d: unknown) => d },
}));

import { applyRules, loadRules } from "../rules";
import { configureGhostery, ghosteryBlock, ghosteryLoadInProgress } from "../ghostery";

const LIST_URL =
  "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ads.json";

async function prime(): Promise<void> {
  configureGhostery((input, init) => {
    cap.inits.push(init);
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  ghosteryBlock(LIST_URL, "script");
  const pending = ghosteryLoadInProgress();
  if (pending) await pending;
}

describe("ghostery list fetch guard", () => {
  it("reaches only Ghostery's asset directory, GET only, manual redirects", async () => {
    await prime();
    const f = cap.listFetch!;
    await expect(f("https://evil.example/lists.txt", {})).rejects.toThrow(TypeError);
    await expect(f(LIST_URL, { method: "POST" })).rejects.toThrow(TypeError);
    const resp = await f(LIST_URL, { method: "GET" });
    expect(resp.ok).toBe(true);
    expect(cap.inits.at(-1)).toMatchObject({ method: "GET", redirect: "manual" });
  });
});

describe("applyRules + Ghostery integration", () => {
  it("a network match blocks with the redirect; local allow and block win", async () => {
    await prime();
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('allow "ads.example"
block "tracker.example"', { status: 200 })) as typeof fetch;
    try {
      const r = await loadRules();
      const gh = applyRules(r, "https://cdn.other.example/ad.js", "script");
      expect(gh.action).toBe("block");
      expect(gh.matched).toBe("Ghostery: ads.example");
      expect(gh.ghosteryRedirect).toEqual({
        body: "/* blocked */",
        contentType: "application/javascript",
      });
      const allow = applyRules(r, "https://ads.example/x.js", "script");
      expect(allow.action).toBe("allow");
      expect(allow.ghosteryRedirect).toBeUndefined();
      const local = applyRules(r, "https://tracker.example/x.js", "script");
      expect(local.action).toBe("block");
      expect(local.matched).toBe("tracker.example");
      expect(local.ghosteryRedirect).toBeUndefined();
    } finally {
      globalThis.fetch = orig;
    }
  });
});
