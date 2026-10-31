import { describe, expect, it } from "vitest";
import {
  capContexts,
  establishFromClientUrl,
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

  it("resolves a directory-relative tail against the document URL, not the origin root", () => {
    /* Bug-scout regression: a missed relative URL from a document in a
       subdirectory (/a/b/page.html referencing img/x.png) used to be
       force-prefixed "/" and resolved to /img/x.png. */
    const m = new Map<string, VirtualContext>();
    establishContext(m, "d", "https://s.example/dir/page.html");
    expect(resolveRelative(m, "d", "img/x.png")).toBe("https://s.example/dir/img/x.png");
    expect(resolveRelative(m, "d", "img/x.png?v=2")).toBe("https://s.example/dir/img/x.png?v=2");
    /* Absolute paths still resolve against the origin root. */
    expect(resolveRelative(m, "d", "/root.png")).toBe("https://s.example/root.png");
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

describe("Virtual context rehydration (issue #535)", () => {
  /* Stand-in for the engine's decodeClientUrl: /j/<rest> routes decode,
     everything else (blob: workers, landing pages) rejects. */
  const dec = (u: URL) =>
    u.pathname.startsWith("/j/")
      ? "https://site.example/" + u.pathname.slice(3)
      : null;

  it("re-establishes a context from a decodable browser-committed client URL", () => {
    const m = new Map<string, VirtualContext>();
    const ctx = establishFromClientUrl(
      m,
      "c1",
      "https://engine.example/j/dir/page.html",
      dec,
    );
    expect(ctx).toEqual({
      id: "c1",
      clientId: "c1",
      targetOrigin: "https://site.example",
      currentUrl: "https://site.example/dir/page.html",
    });
    /* The recovered context resolves relative tails like a live one. */
    expect(resolveRelative(m, "c1", "sub/pixel.png")).toBe(
      "https://site.example/dir/sub/pixel.png",
    );
  });

  it("installs nothing for a client URL the decoder rejects (blob worker fails closed)", () => {
    const m = new Map<string, VirtualContext>();
    expect(
      establishFromClientUrl(m, "w1", "blob:https://engine.example/xyz", dec),
    ).toBeNull();
    expect(m.has("w1")).toBe(false);
  });

  it("installs nothing for an unparseable client URL", () => {
    const m = new Map<string, VirtualContext>();
    expect(establishFromClientUrl(m, "c2", "not a url", dec)).toBeNull();
    expect(m.size).toBe(0);
  });

  it("keeps two clients' rehydrated contexts isolated", () => {
    const m = new Map<string, VirtualContext>();
    const decB = (u: URL) =>
      u.pathname.startsWith("/j/")
        ? "https://other.example/" + u.pathname.slice(3)
        : null;
    establishFromClientUrl(m, "a", "https://engine.example/j/a.html", dec);
    establishFromClientUrl(m, "b", "https://engine.example/j/b.html", decB);
    expect(resolveRelative(m, "a", "/x")).toBe("https://site.example/x");
    expect(resolveRelative(m, "b", "/x")).toBe("https://other.example/x");
    expect(resolveRelative(m, "a", "img/1.png")).toBe(
      "https://site.example/img/1.png",
    );
    expect(resolveRelative(m, "b", "img/1.png")).toBe(
      "https://other.example/img/1.png",
    );
  });
});
