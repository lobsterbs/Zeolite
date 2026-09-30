import { describe, expect, it } from "vitest";
import {
  capContexts,
  contextOf,
  establishContext,
  resolveRelative,
  VCTX_CAP,
  type VirtualContext,
} from "../vctx";

describe("VirtualContext routing (issue #33)", () => {
  it("resolves a page's relative fetch against its own context, no referrer involved", () => {
    const m = new Map<string, VirtualContext>();
    establishContext(m, "doc-1", "https://site.example/page.html?x=1");
    expect(resolveRelative(m, "doc-1", "/api/data?q=2")).toBe("https://site.example/api/data?q=2");
  });

  it("returns null with no context so the referrer compat fallback stays in charge", () => {
    const m = new Map<string, VirtualContext>();
    expect(resolveRelative(m, "doc-1", "/api/data")).toBeNull();
    expect(resolveRelative(m, undefined, "/api/data")).toBeNull();
  });

  it("isolates two simultaneous proxied clients", () => {
    const m = new Map<string, VirtualContext>();
    establishContext(m, "tab-a", "https://a.example/");
    establishContext(m, "tab-b", "https://b.example/");
    expect(resolveRelative(m, "tab-a", "/x")).toBe("https://a.example/x");
    expect(resolveRelative(m, "tab-b", "/x")).toBe("https://b.example/x");
  });

  it("replaces a client's context atomically on a new navigation", () => {
    const m = new Map<string, VirtualContext>();
    establishContext(m, "c1", "https://old.example/");
    const next = establishContext(m, "c1", "https://new.example/next");
    /* whole entry, no half-replaced fields */
    expect(next).toEqual({
      id: "c1",
      clientId: "c1",
      targetOrigin: "https://new.example",
      currentUrl: "https://new.example/next",
    });
    expect(m.get("c1")).toEqual(next);
    expect(resolveRelative(m, "c1", "/x")).toBe("https://new.example/x");
  });

  it("rebuilds after a SW restart from the first decodable request", () => {
    const before = new Map<string, VirtualContext>();
    establishContext(before, "c1", "https://site.example/");
    const after = new Map<string, VirtualContext>(); /* restarted SW: empty */
    expect(resolveRelative(after, "c1", "/api")).toBeNull(); /* referrer carries it */
    establishContext(after, "c1", "https://site.example/page2");
    expect(resolveRelative(after, "c1", "/api")).toBe("https://site.example/api");
  });

  it("gives worker clients their own explicit context", () => {
    const m = new Map<string, VirtualContext>();
    establishContext(m, "page-1", "https://site.example/");
    establishContext(m, "worker-1", "https://cdn.example/lib/worker.js");
    expect(resolveRelative(m, "worker-1", "/dep.js")).toBe("https://cdn.example/dep.js");
    expect(contextOf(m, "worker-1")?.targetOrigin).toBe("https://cdn.example");
  });

  it("fails closed on non-http(s) or unparseable targets", () => {
    const m = new Map<string, VirtualContext>();
    expect(establishContext(m, "c1", "data:text/plain,hi")).toBeNull();
    expect(establishContext(m, "c1", "not a url")).toBeNull();
    expect(m.size).toBe(0);
  });

  it("keeps the map bounded by dropping the oldest contexts", () => {
    const m = new Map<string, VirtualContext>();
    for (let i = 0; i < VCTX_CAP + 10; i++) {
      establishContext(m, "c" + i, "https://s" + i + ".example/");
    }
    capContexts(m, VCTX_CAP);
    expect(m.size).toBe(VCTX_CAP);
    expect(m.has("c0")).toBe(false); /* oldest dropped */
    expect(m.has("c" + (VCTX_CAP + 9))).toBe(true); /* newest kept */
  });
});
