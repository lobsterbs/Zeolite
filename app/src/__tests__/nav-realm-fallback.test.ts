import { describe, expect, it } from "vitest";
import { establishContext, establishFromClientUrl, navRealmDest, unambiguousWindowContext, type VirtualContext } from "../vctx";

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

/* #708 run 12: the four-run race conviction. The identifier page's
   accounts.youtube.com CheckConnection iframe is itself a NAVIGATION
   (mode navigate, destination iframe) whose src decodes, so the
   establish seam installs a WINDOW context for it. Once it lands
   before the botguard /_/bscframe navigation, the strict rule (all
   live windows on ONE upstream origin) turns ambiguous and the frame
   escapes to the SPA shell (runs 10, 11, 12; run 9 won only because
   its warm page cache ordered the race the other way). The tier: a
   nested subframe is a child of the tab's proxied surface, not an
   independent browsing surface, so the nav-realm pass may skip it.
   The strict capability pass must stay strict. */

const checkConnection = (map: Map<string, VirtualContext>, id = "f1") =>
  establishContext(
    map,
    id,
    "https://accounts.youtube.com/checkconnection",
    "window",
    false,
    true,
  );

describe("navigation realm fallback, subframe tier (#708 run-12 race)", () => {
  it("resolves the botguard home when the CheckConnection subframe established first (the runs 10-12 race)", () => {
    const map = fresh();
    signIn(map);
    checkConnection(map);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBe("https://accounts.google.com/_/bscframe");
  });

  it("keeps the strict unambiguity pass failing closed on the same map (the cdn-cgi capability arm must not loosen)", () => {
    const map = fresh();
    signIn(map);
    checkConnection(map);
    expect(unambiguousWindowContext(map)).toBeUndefined();
    expect(unambiguousWindowContext(map, true)?.targetOrigin).toBe(
      "https://accounts.google.com",
    );
  });

  it("still fails closed when two TOP-LEVEL windows sit on different origins (multi-tab #687 preserved)", () => {
    const map = fresh();
    signIn(map);
    establishContext(map, "w2", "https://example.com/");
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBeNull();
  });

  it("skips several cross-origin subframes, not just one", () => {
    const map = fresh();
    signIn(map);
    checkConnection(map);
    establishContext(map, "f3", "https://play.google.com/embed", "window", false, true);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBe("https://accounts.google.com/_/bscframe");
  });

  it("keeps a lone subframe context as the honest home (unchanged)", () => {
    const map = fresh();
    checkConnection(map);
    expect(
      navRealmDest(map, "GET", "navigate", "iframe", "/_/bscframe", ""),
    ).toBe("https://accounts.youtube.com/_/bscframe");
  });

  it("stamps the flag at the establish seam and passes it through the client-URL rehydration", () => {
    const map = fresh();
    expect(checkConnection(map)?.subframe).toBe(true);
    expect(signIn(map)?.subframe).toBeUndefined();
    const rehydrated = establishFromClientUrl(
      map,
      "f9",
      "https://proxy.example/zl-nav/x/https%3A%2F%2Faccounts.youtube.com%2Fc",
      (u) => decodeURIComponent(u.pathname.split("/").pop() ?? ""),
      false,
      true,
    );
    expect(rehydrated?.subframe).toBe(true);
  });
});
