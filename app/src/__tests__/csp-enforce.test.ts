import { describe, expect, it } from "vitest";

/* #527 acceptance, unit side: the engine-side CSP source-list layer -
   planning (evaluable vs unverifiable directives), CSP3 host-source
   matching (exact host, wildcard, port, scheme, path), the per-client
   plan registry lifecycle, the destination-to-directive gate with
   default-src fallback, and the whitelisted marker vocabulary. The
   full request wiring (plan install at document serve, gate at the
   fetch seam) is pinned by suite/e2e/csp-enforce.mjs in a real
   Chromium, the same split #531 uses. */

import {
  cspClearClient,
  cspGate,
  cspSetClient,
  engineCspMarker,
  newCspRegistry,
  planEngineCsp,
  sourceMatches,
} from "../csp-enforce";

const DOC = "https://site.example/page.html";
const SELF = "https://site.example";

function planned(raw: string, doc = DOC) {
  return planEngineCsp(raw, doc);
}

describe("planEngineCsp (#527)", () => {
  it("enforces plain host-source lists in policy order", () => {
    const p = planned("script-src https://cdn.example.com; img-src 'self' https://img.example");
    expect(p.enforced).toEqual(["script-src", "img-src"]);
    expect(p.unsupported).toEqual([]);
    expect(p.selfOrigin).toBe(SELF);
    expect(p.pageScheme).toBe("https:");
  });

  it("default-src is stored as the fallback, not an enforced directive", () => {
    const p = planned("default-src 'self'");
    expect(p.enforced).toEqual([]);
    expect(p.defaultSrc).toEqual([{ k: "self" }]);
  });

  it("nonce, hash and strict-dynamic leave the directive unenforced and marked unsupported", () => {
    const p = planned("script-src 'nonce-abc' 'strict-dynamic' https://cdn.example.com");
    expect(p.enforced).toEqual([]);
    expect(p.unsupported).toEqual(["script-src"]);
    const h = planned("script-src 'sha256-Q=='; connect-src 'self'");
    expect(h.enforced).toEqual(["connect-src"]);
    expect(h.unsupported).toEqual(["script-src"]);
  });

  it("ignores behavioral keywords and non-network scheme sources", () => {
    const p = planned("script-src 'unsafe-inline' 'unsafe-eval' 'report-sample' data: https://cdn.example.com");
    expect(p.enforced).toEqual(["script-src"]);
    const i = planned("img-src * data:");
    expect(i.enforced).toEqual(["img-src"]);
    expect(i.sources.get("img-src")).toEqual([{ k: "any" }]);
  });

  it("duplicate directives, commas, control bytes and oversize policies yield an empty plan", () => {
    expect(planned("script-src 'self'; script-src 'self'").enforced).toEqual([]);
    expect(planned("script-src 'self', https://x.example").enforced).toEqual([]);
    expect(planned("script-src 'self'\x00").enforced).toEqual([]);
    expect(planned("script-src " + "https://x.example ".repeat(1200)).enforced).toEqual([]);
  });

  it("a non-network or malformed document URL yields an empty plan", () => {
    expect(planEngineCsp("script-src 'self'", "ftp://x.example/").enforced).toEqual([]);
    expect(planEngineCsp("script-src 'self'", "::::").enforced).toEqual([]);
  });

  it("parses host sources into scheme, wildcard, port and path parts", () => {
    const p = planned("img-src https://*.example.com:*/lib/");
    expect(p.sources.get("img-src")).toEqual([
      { k: "host", scheme: "https", host: "example.com", wildcard: true, port: "*", path: "/lib/" },
    ]);
  });
});

describe("sourceMatches, CSP3 host-source semantics (#527)", () => {
  const plan = planned("script-src 'self'", DOC);

  const u = (s: string) => new URL(s);

  it("a plain host matches exactly, never subdomains", () => {
    const src = planned("script-src https://cdn.example.com").sources.get("script-src")![0]!;
    expect(sourceMatches(src, u("https://cdn.example.com/a.js"), plan)).toBe(true);
    expect(sourceMatches(src, u("https://sub.cdN.Example.com/a.js"), plan)).toBe(false);
  });

  it("a wildcard host matches subdomains only, never the apex", () => {
    const src = planned("script-src https://*.example.com").sources.get("script-src")![0]!;
    expect(sourceMatches(src, u("https://sub.example.com/a.js"), plan)).toBe(true);
    expect(sourceMatches(src, u("https://a.b.example.com/a.js"), plan)).toBe(true);
    expect(sourceMatches(src, u("https://example.com/a.js"), plan)).toBe(false);
    expect(sourceMatches(src, u("https://notexample.com/a.js"), plan)).toBe(false);
  });

  it("an absent port matches only the scheme default port", () => {
    const src = planned("script-src https://cdn.example.com").sources.get("script-src")![0]!;
    expect(sourceMatches(src, u("https://cdn.example.com:443/a.js"), plan)).toBe(true);
    expect(sourceMatches(src, u("https://cdn.example.com:8443/a.js"), plan)).toBe(false);
    const any = planned("script-src https://cdn.example.com:*").sources.get("script-src")![0]!;
    expect(sourceMatches(any, u("https://cdn.example.com:8443/a.js"), plan)).toBe(true);
  });

  it("a scheme-less source matches the page scheme only", () => {
    const src = planned("script-src cdn.example.com").sources.get("script-src")![0]!;
    expect(sourceMatches(src, u("https://cdn.example.com/a.js"), plan)).toBe(true);
    expect(sourceMatches(src, u("http://cdn.example.com/a.js"), plan)).toBe(false);
  });

  it("a trailing slash is a path prefix; no slash is exact", () => {
    const pre = planned("script-src https://cdn.example.com/lib/").sources.get("script-src")![0]!;
    expect(sourceMatches(pre, u("https://cdn.example.com/lib/a.js"), plan)).toBe(true);
    expect(sourceMatches(pre, u("https://cdn.example.com/libx/a.js"), plan)).toBe(false);
    const exact = planned("script-src https://cdn.example.com/app.js").sources.get("script-src")![0]!;
    expect(sourceMatches(exact, u("https://cdn.example.com/app.js"), plan)).toBe(true);
    expect(sourceMatches(exact, u("https://cdn.example.com/app.js?x=1"), plan)).toBe(true);
    expect(sourceMatches(exact, u("https://cdn.example.com/app.jsx"), plan)).toBe(false);
  });

  it("'self' matches the document origin exactly", () => {
    const src = planned("script-src 'self'").sources.get("script-src")![0]!;
    expect(sourceMatches(src, u("https://site.example/lib/a.js"), plan)).toBe(true);
    expect(sourceMatches(src, u("https://other.example/lib/a.js"), plan)).toBe(false);
    expect(sourceMatches(src, u("https://site.example:8443/lib/a.js"), plan)).toBe(false);
  });
});

describe("cspGate: destination mapping and default-src fallback (#527)", () => {
  it("blocks a script outside the list, allows one inside", () => {
    const reg = newCspRegistry();
    cspSetClient(reg, "c1", planned("script-src 'self'"));
    expect(cspGate(reg, "c1", "script", "https://site.example/a.js")).toEqual({ blocked: false, directive: "script-src" });
    expect(cspGate(reg, "c1", "script", "https://evil.example/a.js")).toEqual({ blocked: true, directive: "script-src" });
  });

  it("falls back to default-src when the specific directive is absent", () => {
    const reg = newCspRegistry();
    cspSetClient(reg, "c1", planned("default-src 'self'"));
    expect(cspGate(reg, "c1", "image", "https://evil.example/a.png").blocked).toBe(true);
    expect(cspGate(reg, "c1", "image", "https://site.example/a.png").blocked).toBe(false);
    expect(cspGate(reg, "c1", "font", "https://evil.example/a.woff").directive).toBe("default-src");
  });

  it("an unverifiable directive stays unenforced (false allow), other directives still gate", () => {
    const reg = newCspRegistry();
    cspSetClient(reg, "c1", planned("script-src 'nonce-x'; img-src 'self'"));
    expect(cspGate(reg, "c1", "script", "https://evil.example/a.js").blocked).toBe(false);
    expect(cspGate(reg, "c1", "image", "https://evil.example/a.png").blocked).toBe(true);
  });

  it("maps fetch destinations to their directives", () => {
    const reg = newCspRegistry();
    cspSetClient(reg, "c1", planned("style-src 'self'; media-src 'self'; connect-src 'self'; font-src 'self'"));
    expect(cspGate(reg, "c1", "style", "https://evil.example/a.css").directive).toBe("style-src");
    expect(cspGate(reg, "c1", "audio", "https://evil.example/a.mp3").directive).toBe("media-src");
    expect(cspGate(reg, "c1", "video", "https://evil.example/a.mp4").blocked).toBe(true);
    expect(cspGate(reg, "c1", "empty", "https://evil.example/api").directive).toBe("connect-src");
    expect(cspGate(reg, "c1", "font", "https://evil.example/a.woff").directive).toBe("font-src");
    /* Ungated classes: navigations, workers, manifests, objects. */
    expect(cspGate(reg, "c1", "document", "https://evil.example/").blocked).toBe(false);
    expect(cspGate(reg, "c1", "worker", "https://evil.example/w.js").blocked).toBe(false);
    expect(cspGate(reg, "c1", "iframe", "https://evil.example/").blocked).toBe(false);
  });

  it("client plans are isolated and cleared per client", () => {
    const reg = newCspRegistry();
    cspSetClient(reg, "c1", planned("script-src 'self'"));
    cspSetClient(reg, "c2", planned("script-src https://evil.example"));
    expect(cspGate(reg, "c1", "script", "https://evil.example/a.js").blocked).toBe(true);
    expect(cspGate(reg, "c2", "script", "https://evil.example/a.js").blocked).toBe(false);
    expect(cspGate(reg, "c3", "script", "https://evil.example/a.js").blocked).toBe(false);
    cspClearClient(reg, "c2");
    expect(cspGate(reg, "c2", "script", "https://evil.example/a.js").blocked).toBe(false);
  });

  it("non-http(s) targets and unknown clients never block", () => {
    const reg = newCspRegistry();
    cspSetClient(reg, "c1", planned("script-src 'self'"));
    expect(cspGate(reg, "c1", "script", "data:text/plain,x").blocked).toBe(false);
    expect(cspGate(reg, undefined, "script", "https://evil.example/a.js").blocked).toBe(false);
    expect(cspGate(reg, "c1", "script", "::::").blocked).toBe(false);
  });
});

describe("engineCspMarker (#527)", () => {
  it("carries only whitelisted directive names, never upstream source text", () => {
    const p = planned("script-src 'nonce-secretvalue' https://cdn.example.com; img-src 'self'");
    expect(engineCspMarker(p)).toBe("engine img-src; engine-unsupported script-src");
    /* No policy at all: no marker segment. */
    expect(engineCspMarker(planned("upgrade-insecure-requests"))).toBe(null);
    /* A default-src-only policy is genuinely enforced (fallback), so
       the marker must say so instead of reporting nothing. */
    expect(engineCspMarker(planned("default-src 'self'"))).toBe("engine default-src");
    expect(engineCspMarker(planned("script-src 'self'; default-src 'self'"))).toBe(
      "engine script-src,default-src",
    );
  });
});
