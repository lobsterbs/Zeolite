import { describe, expect, it } from "vitest";
import { decodePath, encodeDest } from "../codec";
import { navEncode } from "../bootstrap/navguard";
import { initScript } from "../pageload";
import { errorPage } from "../errorpage";
import { mapRefreshHeader, stripHostile } from "../headers";

/* Issue #32 acceptance: the real destination string must be absent
   from every page-visible surface the engine produces: routes in the
   address bar and history, the injected init script, navigation-guard
   markers in DOM attributes, and the engine-owned error page. */
const TARGET = "https://leaky.example.org/private/page?secret=1";

describe("page-visible surfaces never carry the plaintext destination (#32)", () => {
  it("engine routes", () => {
    const route = encodeDest(TARGET);
    expect(route).not.toContain("leaky.example.org");
    expect(route).not.toContain("private");
    expect(route).not.toContain("secret");
  });

  it("the injected init script", () => {
    expect(initScript(TARGET, null)).not.toContain("leaky.example.org");
    expect(initScript(TARGET, "/*fp*/")).not.toContain("leaky.example.org");
  });

  it("navigation guard markers", () => {
    expect(navEncode(TARGET)).not.toContain("leaky.example.org");
  });

  it("the engine error page", () => {
    const p = errorPage({ route: "/j/x", category: "dns", engineVersion: "v" });
    expect(p).not.toContain("leaky.example.org");
    expect(p).not.toContain("https://");
  });

  it("b64u is obfuscation, not encryption: the codec decodes its own routes", () => {
    /* Honest bound, not a flaw: decodePath is as public as the route
       scheme itself. #32 removes the plaintext from every
       page-visible surface; it does not make the target secret from
       whoever already holds the route. */
    expect(decodePath(encodeDest(TARGET))).toBe(TARGET);
  });
});


describe("response-header surgery never carries the plaintext destination", () => {
  const H: Record<string, string> = {
    "content-security-policy": "img-src https://leaky.example.org",
    link: "<https://leaky.example.org/a.js>; rel=preload",
    "content-location": "https://leaky.example.org/private/page",
    "x-original-url": "https://leaky.example.org/private/page",
    "content-type": "text/html",
  };

  it("destination-bearing headers are stripped, others survive", () => {
    const out = stripHostile(new Headers(H));
    for (const [k, v] of out) {
      expect(v).not.toContain("leaky.example.org");
    }
    expect(out.get("content-type")).toBe("text/html");
  });

  it("Refresh url= is re-encoded to an engine route", () => {
    const h = new Headers({ refresh: '5; url="https://leaky.example.org/next"' });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    const out = h.get("refresh")!;
    expect(out).not.toContain("leaky.example.org");
    expect(out.startsWith("5; url=")).toBe(true);
    expect(decodePath(out.slice("5; url=".length))).toBe("https://leaky.example.org/next");
  });

  it("relative Refresh url resolves against the response destination", () => {
    const h = new Headers({ refresh: "0; url=/other" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    const out = h.get("refresh")!;
    expect(out).not.toContain("leaky.example.org");
    expect(decodePath(out.slice("0; url=".length))).toBe("https://leaky.example.org/other");
  });

  it("same-page Refresh (no url=) survives untouched", () => {
    const h = new Headers({ refresh: "30" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    expect(h.get("refresh")).toBe("30");
  });

  it("unresolvable Refresh url= fails closed", () => {
    const h = new Headers({ refresh: "5; url=://broken" });
    mapRefreshHeader(h, "https://leaky.example.org/private/page");
    expect(h.get("refresh")).toBeNull();
  });
});
