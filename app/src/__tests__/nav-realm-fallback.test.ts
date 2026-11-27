import { describe, expect, it } from "vitest";
import { establishContext, navRealmDest, type VirtualContext } from "../vctx";

/* #708 run 8: the sign-in page's botguard iframe src ("/_/bscframe",
   committed at the content-origin root with a live ?zlNavh handle)
   arrived context-less - no bearing clientId, no referrer any codec
   arm decodes - so the #101 escape served the origin's SPA catch-all
   INTO the botguard frame. The recovery is the unambiguous
   live-window realm: resolve the bare path against the page's own
   virtual home, with every edge here pinned fail-closed. */

const signIn = (map: Map<string, VirtualContext>, id = "w1") =>
  establishContext(
    map,
    id,
    "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Faccounts.google.com%2F",
  );

const fresh = (): Map<string, VirtualContext> => new Map();

describe("navigation realm fallback (#708 run-8 class)", () => {
  it("routes a context-less bare-src subframe navigation to the live page's home", () => {
    const map = fresh();
    signIn(map);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBe("https://accounts.google.com/_/bscframe");
  });

  it("keeps the request's own query on the resolved destination", () => {
    const map = fresh();
    signIn(map);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", "?x=1"),
    ).toBe("https://accounts.google.com/_/bscframe?x=1");
  });

  it("resolves against the establishing document's origin, not its path", () => {
    const map = fresh();
    establishContext(map, "w1", "https://accounts.google.com/v3/signin/identifier");
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBe("https://accounts.google.com/_/bscframe");
  });

  it("fails closed when live window contexts sit on different upstream origins (#687)", () => {
    const map = fresh();
    signIn(map);
    establishContext(map, "w2", "https://example.com/");
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBeNull();
  });

  it("fails closed with no live window context", () => {
    expect(
      navRealmDest(fresh(), "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBeNull();
  });

  it("skips worker contexts in the unambiguity count (#596)", () => {
    const map = fresh();
    establishContext(map, "k1", "https://example.com/worker.js", "worker");
    signIn(map);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBe("https://accounts.google.com/_/bscframe");
  });

  it("fails closed when only worker contexts are live", () => {
    const map = fresh();
    establishContext(map, "k1", "https://example.com/worker.js", "worker");
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBeNull();
  });

  it("keeps non-GET and subresource-shaped requests on the honest escape", () => {
    const map = fresh();
    signIn(map);
    expect(
      navRealmDest(map, "POST", "navigate", "iframe", "/_/bscframe", ""),
    ).toBeNull();
    expect(
      navRealmDest(map, "GET", "no-cors", "script", "/_/bscframe", ""),
    ).toBeNull();
    expect(
      navRealmDest(map, "GET", "navigate", "script", "/_/bscframe", ""),
    ).toBeNull();
    expect(
      navRealmDest(map, "GET", "cors", "empty", "/_/bscframe", ""),
    ).toBeNull();
  });

  it("never hijacks a top-level document navigation (the address-bar class)", () => {
    const map = fresh();
    signIn(map);
    expect(
      navRealmDest(map, "GET", "navigate", "document", "/_/bscframe", ""),
    ).toBeNull();
  });

  it("never routes the host's own origin-root surfaces (boot guest host, engine assets)", () => {
    const map = fresh();
    signIn(map);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/guest-host.html", ""),
    ).toBeNull();
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/devtools.html", ""),
    ).toBeNull();
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/sw.js", ""),
    ).toBeNull();
  });
});
