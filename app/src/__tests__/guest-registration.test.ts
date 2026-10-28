import { describe, expect, it } from "vitest";
import {
  canonicalGuestRegistration,
  validateStoredGuestRegistration,
  guestScopeMatches,
  GuestRegistrationRegistry,
} from "../kernel/guests/registration";
import { swShimGet, swShimRegister } from "../swshim";

const page = "https://site.example/app/page.html";
const fakeStore = () => {
  let record: string | null = null;
  return { get: () => record, set: (s: string) => { record = s; }, clear: () => { record = null; } };
};

describe("guest registration identity: non-execution P0/P1 (#477)", () => {
  it("resolves default scope to the script directory, not the page directory", () => {
    expect(canonicalGuestRegistration(page, "/sw/main.js")).toEqual({
      origin: "https://site.example",
      scriptURL: "https://site.example/sw/main.js",
      scope: "https://site.example/sw/",
    });
    expect(canonicalGuestRegistration(page, "/sw/main.js", "../")).toMatchObject({
      scope: "https://site.example/",
    });
  });

  it("rejects foreign scripts, lookalikes, foreign scopes and unusable schemes", () => {
    for (const script of ["https://site.example.evil/sw.js", "https://evil.example/sw.js", "javascript:alert(1)", "data:text/javascript,x"]) {
      expect(() => canonicalGuestRegistration(page, script)).toThrow(TypeError);
    }
    expect(() => canonicalGuestRegistration(page, "/sw.js", "https://site.example.evil/")).toThrow(TypeError);
    expect(() => canonicalGuestRegistration("file:///tmp/page.html", "sw.js")).toThrow(TypeError);
  });

  it("rejects ambiguous or fragment-bearing scope/script paths", () => {
    for (const script of ["/sw%2fsecret.js", "/sw%5csecret.js", "/sw.js#fragment", "/sw.js?x=1#frag"]) {
      expect(() => canonicalGuestRegistration(page, script)).toThrow(TypeError);
    }
    for (const scope of ["/app%2fother/", "/app%5cother/", "/app/?p=1", "/app/#frag"]) {
      expect(() => canonicalGuestRegistration(page, "/sw.js", scope)).toThrow(TypeError);
    }
  });

  it("validates both the origin of a persisted script and its scope", () => {
    const good = { scriptURL: "https://site.example/sw.js", scope: "https://site.example/" };
    expect(validateStoredGuestRegistration(page, good)?.scriptURL).toBe(good.scriptURL);
    for (const bad of [
      { scriptURL: "https://evil.example/sw.js", scope: good.scope },
      { scriptURL: good.scriptURL, scope: "https://evil.example/" },
      { scriptURL: "/sw.js", scope: good.scope },
      { scriptURL: good.scriptURL, scope: "https://site.example/app%2ftrick" },
      { scriptURL: 2, scope: good.scope },
      null,
    ]) {
      expect(validateStoredGuestRegistration(page, bad)).toBeNull();
    }
  });

  it("the pure validator blocks poisoned stored script URLs independently of the legacy page shim", () => {
    const store = fakeStore();
    store.set(JSON.stringify({ scriptURL: "https://evil.example/worker.js", scope: "https://site.example/" }));
    expect(validateStoredGuestRegistration(page, JSON.parse(store.get()!))).toBeNull();
    store.set(JSON.stringify({ scriptURL: "https://site.example/sw.js", scope: "https://site.example/" }));
    expect(swShimGet(store, page)?.active?.scriptURL).toBe("https://site.example/sw.js");
    expect(() => swShimRegister(store, page, "https://evil.example/sw.js")).toThrow(TypeError);
  });

  it("matches longest-prefix scopes only within the exact verified origin", () => {
    const r = new GuestRegistrationRegistry();
    r.register(page, "/sw.js", "/");
    r.register(page, "/app/sw.js", "/app/");
    r.register(page, "/app/nested/sw.js", "/app/nested/");
    expect(r.find(page, "/app/page.html?q=1")?.scope).toBe("https://site.example/app/");
    expect(r.find(page, "/app/nested/p")?.scope).toBe("https://site.example/app/nested/");
    expect(r.find(page, "/other")?.scope).toBe("https://site.example/");
    expect(r.find(page, "https://site.example.evil/app/")).toBeNull();
    expect(guestScopeMatches("https://site.example/app/", "https://site.example/apple")).toBe(false);
  });

  it("namespaces scope records by full origin, never by a short hash or shared path", () => {
    const r = new GuestRegistrationRegistry();
    r.register("https://a.example/p", "sw.js", "/");
    r.register("https://b.example/p", "sw.js", "/");
    expect(r.count()).toBe(2);
    expect(r.find("https://a.example/p", "https://a.example/p")?.origin).toBe("https://a.example");
    expect(r.find("https://b.example/p", "https://b.example/p")?.origin).toBe("https://b.example");
    expect(r.find("https://a.example/p", "https://b.example/p")).toBeNull();
  });

  it("enforces a bounded registry with replacement and explicit unregister/teardown", () => {
    const r = new GuestRegistrationRegistry(2);
    r.register(page, "/first.js", "/a/");
    r.register(page, "/second.js", "/b/");
    expect(() => r.register(page, "/third.js", "/c/")).toThrow(RangeError);
    r.register(page, "/updated.js", "/a/");
    expect(r.find(page, "/a/page")?.scriptURL).toBe("https://site.example/updated.js");
    expect(r.unregister(page, "https://evil.example/a/")).toBe(false);
    expect(r.unregister(page, "https://site.example/a/")).toBe(true);
    expect(r.count()).toBe(1);
    r.clear();
    expect(r.count()).toBe(0);
  });

  it("cannot gain execution merely by creating a registration record", () => {
    const r = new GuestRegistrationRegistry();
    const rec = r.register(page, "/sw.js");
    expect(Object.keys(rec).sort()).toEqual(["origin", "scope", "scriptURL"]);
    expect("fetch" in rec).toBe(false);
    expect("postMessage" in rec).toBe(false);
    expect("controller" in rec).toBe(false);
    expect("execute" in rec).toBe(false);
  });
});
