import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteRules } from "../siteconfig";
const state = vi.hoisted(() => ({ rules: {} as SiteRules, seen: [] as Array<[string, string, number]>, freed: 0 }));
vi.mock("../siteconfig", async importOriginal => ({
  ...await importOriginal<typeof import("../siteconfig")>(),
  siteRules: async () => state.rules,
}));
vi.mock("../rewriter_wasm/rewriter_wasm.js", () => ({
  default: async () => {},
  JsRewriter: class {
    constructor(_origin: string, private base: string) {}
    set_location_policy(mode: string, cap: number) { state.seen.push([this.base, mode, cap]); }
    rewrite_script(source: string) { return source; }
    process(source: string) { return source; }
    finish() { return ""; }
    take_location_events() { return "rewritten"; }
    free() { state.freed++; }
  },
}));
import { initTransform, rewriteJsBody, rewriteStream } from "../transform";
import { resetExperimentalForTests, selectExperimental } from "../experimental-flags";

beforeEach(() => {
  state.rules = { "page.example": { locationRewrite: { mode: "hybrid", maxBytes: 65536 } } };
  state.seen = []; state.freed = 0;
  vi.stubGlobal("self", { location: { origin: "https://engine.example", href: "https://engine.example/sw.js" } });
  initTransform({ routeReady: async () => {}, routeKey: () => null, fpScript: () => null,
    siteScript: async () => null, setDegraded: () => {}, lazyImages: () => false });
});
afterEach(() => { vi.unstubAllGlobals(); resetExperimentalForTests(); });

describe("location policy transform wiring", () => {
  it("uses the page policy for external CDN scripts while preserving their resolution base", async () => {
    await rewriteJsBody("location.pathname", "https://cdn.example/code.js", "https://page.example/path");
    expect(state.seen).toEqual([["https://cdn.example/code.js", "hybrid", 65536]]);
    expect(state.freed).toBe(1);
  });
  it("keeps legacy mode when the initiating page is unknown", async () => {
    /* #456 operator flip 2026-11-01: the pristine default is hybrid
       ON; deselect so this test keeps pinning the unknown-initiator
       invariant - the page.example rule must NOT be guessed from the
       resource URL, and the flag-off fallback stays legacy. */
    selectExperimental({ hybridLocation: false });
    await rewriteJsBody("location.pathname", "https://page.example/code.js");
    expect(state.seen[0]).toEqual(["https://page.example/code.js", "legacy", 2097152]);
  });
  it("applies the same policy to streamed inline script bodies", async () => {
    const body = new Response("<script>location.pathname</script>").body!;
    const rule = state.rules["page.example"];
    await new Response(rewriteStream(body, "https://page.example/path", rule, [], "text/html", undefined, false)).text();
    expect(state.seen).toEqual([["https://page.example/path", "hybrid", 65536]]);
  });
});
