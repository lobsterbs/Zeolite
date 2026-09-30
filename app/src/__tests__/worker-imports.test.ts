import { describe, expect, it, beforeEach } from "vitest";
import { decodePath, setScheme } from "../codec";
import {
  rewriteModuleWorkerImports,
  routeModuleSpecifier,
} from "../worker-imports";

const P = "/j/";
const W = "https://api.site/worker.js";
const E = "https://engine.host";

beforeEach(() => setScheme(P));

describe("routeModuleSpecifier", () => {
  it("routes absolute http(s) specifiers through the engine codec", () => {
    const out = routeModuleSpecifier(P, W, E, "https://cdn.other/lib.js");
    expect(out.startsWith(P)).toBe(true);
    expect(decodePath(out)).toBe("https://cdn.other/lib.js");
  });

  it("routes relative specifiers against the worker URL", () => {
    const out = routeModuleSpecifier(P, W, E, "./util.js");
    expect(decodePath(out)).toBe("https://api.site/util.js");
    expect(decodePath(routeModuleSpecifier(P, W, E, "/root.js"))).toBe("https://api.site/root.js");
  });

  it("passes bare, opaque, engine-local and already-routed specifiers through", () => {
    expect(routeModuleSpecifier(P, W, E, "react")).toBe("react");
    expect(routeModuleSpecifier(P, W, E, "data:text/javascript,hi")).toBe("data:text/javascript,hi");
    expect(routeModuleSpecifier(P, W, E, E + "/j/abc")).toBe(E + "/j/abc");
    expect(routeModuleSpecifier(P, W, E, "/j/abc")).toBe("/j/abc");
    expect(routeModuleSpecifier(P, W, E, "not a url")).toBe("not a url");
  });

});

describe("rewriteModuleWorkerImports", () => {
  it("rewrites static import, side-effect import and export-from", () => {
    const src = [
      'import { a } from "./a.js";',
      'import "https://cdn.other/side.js";',
      'export { b } from "./b.js";',
    ].join("\n");
    const out = rewriteModuleWorkerImports(P, W, E, src);
    expect(decodePath(out.match(/from "([^"]+)"/)![1])).toBe("https://api.site/a.js");
    expect(decodePath(out.match(/import "([^"]+)"/)![1])).toBe("https://cdn.other/side.js");
    expect(decodePath(out.match(/export \{ b \} from "([^"]+)"/)![1])).toBe("https://api.site/b.js");
  });

  it("rewrites dynamic import() specifiers", () => {
    const out = rewriteModuleWorkerImports(P, W, E, 'const m = await import("./lazy.js");');
    expect(decodePath(out.match(/import\("([^"]+)"\)/)![1])).toBe("https://api.site/lazy.js");
  });

  it("leaves bare specifiers, import.meta and non-import code untouched", () => {
    const src = 'import x from "react";\nconst u = import.meta.url;\nconst s = "from \\"not-a-spec\\"";';
    expect(rewriteModuleWorkerImports(P, W, E, src)).toBe(src);
  });

  it("is a pure text pass: same input, same output", () => {
    const src = 'import { a } from "./a.js";\nexport * from "https://cdn.other/x.js";';
    expect(rewriteModuleWorkerImports(P, W, E, src)).toBe(rewriteModuleWorkerImports(P, W, E, src));
  });

  it("follows the rotated prefix", () => {
    setScheme("/zl/");
    const out = rewriteModuleWorkerImports("/zl/", W, E, 'import "./a.js";');
    expect(out).toContain("/zl/");
    expect(decodePath(out.match(/"([^"]+)"/)![1])).toBe("https://api.site/a.js");
  });
});
