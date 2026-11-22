/* #702: webRequest request-to-tab attribution. The registry's
   details must carry the honest tab id the engine resolved: a
   real UI tab id on an exact destination match, -1 otherwise. */
import { describe, expect, it } from "vitest";
import { TABS } from "../tabs";
import { WEBREQ, wrTabFor, type WrDetails } from "../webrequest";

function details(tabId: number): WrDetails {
  return { requestId: "r1", url: "https://example.com/x", method: "GET", type: "main_frame", tabId, timeStamp: 1 };
}

describe("webRequest tab attribution (#702)", () => {
  it("wrTabFor matches the initiating page's URL exactly", () => {
    TABS.syncFromUi([{ id: 42, index: 0, url: "https://example.com/x", title: "T", active: true }]);
    expect(wrTabFor("https://example.com/x", undefined)).toBe(42);
  });

  it("wrTabFor matches a main-frame navigation target", () => {
    expect(wrTabFor(undefined, "https://example.com/x")).toBe(42);
  });

  it("never fabricates: mismatches and an empty registry report -1", () => {
    expect(wrTabFor("https://example.com/y", undefined)).toBe(-1);
    expect(wrTabFor("https://example.com/x?z=1", undefined)).toBe(-1);
    expect(wrTabFor(undefined, undefined)).toBe(-1);
    TABS.syncFromUi([]);
    expect(wrTabFor("https://example.com/x", undefined)).toBe(-1);
  });

  it("delivers the resolved tabId through the registry unchanged", () => {
    WEBREQ.resetForTests();
    const seen: WrDetails[] = [];
    const off = WEBREQ.register("ext-t", "beforeRequest", (d: WrDetails) => {
      seen.push(d);
    }, { perm: () => ({ hostPatterns: ["<all_urls>"], canBlock: false }), urls: [] });
    WEBREQ.beforeRequest(details(7));
    off();
    expect(seen.length).toBe(1);
    expect(seen[0]?.tabId).toBe(7);
  });
});
