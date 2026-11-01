import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  WEBNAV,
  navigationFilterPredicate,
  type NavigationUrlFilter,
} from "../webnavigation";
import { TABS } from "../tabs";

/* #560 residual: Firefox's webNavigation UrlFilter. The registry
   predicate layer is exercised directly; delivery permission-gating
   and tab resolution are covered by the existing webnavigation and
   phase2 suites. */

function hit(filter: NavigationUrlFilter, url: string): boolean {
  return navigationFilterPredicate(filter)(url);
}

describe("webNavigation UrlFilter (#560 residual)", () => {
  it("matches hostEquals, urlPrefix, urlSuffix and urlContains", () => {
    const u = "https://docs.example.org/guide/intro.html?page=2#top";
    expect(hit({ hostEquals: "docs.example.org" }, u)).toBe(true);
    expect(hit({ hostEquals: "example.org" }, u)).toBe(false);
    expect(hit({ urlPrefix: "https://docs.example.org/guide" }, u)).toBe(true);
    expect(hit({ urlPrefix: "https://docs.example.org/api" }, u)).toBe(false);
    expect(hit({ urlSuffix: "2#top" }, u)).toBe(true);
    expect(hit({ urlSuffix: ".html" }, u)).toBe(false);
    expect(hit({ urlSuffix: ".html" }, "https://docs.example.org/guide/intro.html")).toBe(true);
    expect(hit({ urlContains: "intro" }, u)).toBe(true);
    expect(hit({ urlContains: "missing" }, u)).toBe(false);
  });

  it("matches queryEquals against the exact query and urlMatches against the whole URL", () => {
    const u = "https://s.example/search?q=zeolite&lang=en";
    expect(hit({ queryEquals: "q=zeolite&lang=en" }, u)).toBe(true);
    expect(hit({ queryEquals: "q=zeolite" }, u)).toBe(false);
    expect(hit({ urlMatches: "search\\?q=zeolite" }, u)).toBe(true);
    expect(hit({ urlMatches: "search\\?q=other" }, u)).toBe(false);
  });

  it("matches originAndPathMatches against origin+path, query excluded", () => {
    const u = "https://shop.example/cart/items?from=nav";
    expect(hit({ originAndPathMatches: "cart/items" }, u)).toBe(true);
    expect(hit({ originAndPathMatches: "cart/items\\?from" }, u)).toBe(false);
    expect(hit({ originAndPathMatches: "^https://shop\\.example/cart/" }, u)).toBe(true);
    expect(hit({ originAndPathMatches: "^https://other\\.example/cart/" }, u)).toBe(false);
  });

  it("matches ports, with scheme defaults for the empty port", () => {
    expect(hit({ ports: [8443] }, "https://p.example:8443/x")).toBe(true);
    expect(hit({ ports: [8443] }, "https://p.example:9443/x")).toBe(false);
    expect(hit({ ports: [[8000, 9000]] }, "https://p.example:8888/x")).toBe(true);
    expect(hit({ ports: [[8000, 9000]] }, "https://p.example:9999/x")).toBe(false);
    /* Empty port = scheme default: 443 for https, 80 for http. */
    expect(hit({ ports: [443] }, "https://p.example/x")).toBe(true);
    expect(hit({ ports: [80] }, "https://p.example/x")).toBe(false);
    expect(hit({ ports: [80] }, "http://p.example/x")).toBe(true);
  });

  it("ANDs every key present and treats unparseable urls as no-match", () => {
    const u = "https://a.example/p?x=1";
    expect(hit({ hostEquals: "a.example", urlPrefix: "https://", urlSuffix: "=1" }, u)).toBe(true);
    expect(hit({ hostEquals: "a.example", urlSuffix: "=2" }, u)).toBe(false);
    expect(hit({ hostEquals: "a.example" }, "not a url")).toBe(false);
  });

  it("throws on invalid regexes at compile time, like Firefox throws at the call", () => {
    expect(() => navigationFilterPredicate({ urlMatches: "(" })).toThrow();
    expect(() => navigationFilterPredicate({ originAndPathMatches: "[" })).toThrow();
  });

  it("keeps delivering through the registry with a rich filter (tab-resolved)", () => {
    TABS.syncFromUi([{ id: 5, index: 5, url: "https://filtered.example/page", title: "t5", active: true }]);
    const seen: number[] = [];
    const off = WEBNAV.subscribeKind("committed", (i) => seen.push(i.tabId), {
      hostEquals: "filtered.example",
    });
    WEBNAV.committed("https://filtered.example/page");
    off();
    WEBNAV.committed("https://filtered.example/page");
    expect(seen).toEqual([5]);
    /* A rich filter that does not match delivers nothing. */
    const off2 = WEBNAV.subscribeKind("committed", (i) => seen.push(i.tabId), {
      hostEquals: "other.example",
    });
    WEBNAV.committed("https://filtered.example/page");
    off2();
    expect(seen).toEqual([5]);
    TABS.syncFromUi([]);
  });
});
