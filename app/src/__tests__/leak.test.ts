import { describe, expect, it } from "vitest";
import { decodePath, encodeDest } from "../codec";
import { navEncode } from "../bootstrap/navguard";
import { initScript } from "../pageload";
import { errorPage } from "../errorpage";

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
