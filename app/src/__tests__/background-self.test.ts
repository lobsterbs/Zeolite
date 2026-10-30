import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBackgroundDocument, buildBackgroundSelf } from "../extensions/background";

/* Issue #560: Tampermonkey 5.5.0's background destructures location
   from self at module scope (const {..., location: ie} = self ... then
   const Ae = ie.origin), and the sandbox proxy answered every
   property from the extension API object alone, so self.location was
   undefined and the synchronous boot died with "TypeError: Cannot
   read properties of undefined (reading 'origin')". A real MV2
   background page's self IS its global scope, so the sandbox must
   answer platform globals from the real worker scope when the API
   surface does not name them. These tests pin that contract with the
   exact expression that crashed the boot. */

const LOC = {
  origin: "https://engine.example",
  href: "https://engine.example/zlsw/sw.js",
  host: "engine.example",
  protocol: "https:",
};

describe("background sandbox self (#560)", () => {
  const g = globalThis as Record<string, unknown>;
  let prevLoc: unknown;
  let hadLoc: boolean;

  beforeEach(() => {
    prevLoc = g.location;
    hadLoc = Object.prototype.hasOwnProperty.call(g, "location");
    g.location = LOC;
  });
  afterEach(() => {
    if (hadLoc) g.location = prevLoc;
    else delete g.location;
  });

  it("answers the boot-time location read that crashed Tampermonkey", () => {
    const api = { runtime: { id: "tm@example" } } as Record<string, unknown>;
    const sandbox = buildBackgroundSelf(api) as Record<string, unknown>;
    const { location } = sandbox as { location: { origin: string } };
    expect(location.origin).toBe("https://engine.example");
  });

  it("falls through to the worker globals a page-shaped background reads", () => {
    const api = { runtime: { id: "tm@example" } } as Record<string, unknown>;
    const sandbox = buildBackgroundSelf(api) as Record<string, unknown>;
    expect(sandbox.atob).toBe(g.atob);
    expect(sandbox.setTimeout).toBe(g.setTimeout);
    expect(sandbox.fetch).toBe(g.fetch);
    expect(sandbox.crypto).toBe(g.crypto);
  });

  it("the API object still shadows, and addEventListener stays the no-op", () => {
    const api = {
      runtime: { id: "tm@example" },
      storage: { local: {} },
    } as Record<string, unknown>;
    const sandbox = buildBackgroundSelf(api) as Record<string, unknown>;
    expect(sandbox.runtime).toBe(api.runtime);
    expect(sandbox.storage).toBe(api.storage);
    expect((sandbox.addEventListener as () => undefined)()).toBeUndefined();
  });

  it("symbol-keyed reads do not throw and answer nothing", () => {
    const api = { runtime: { id: "tm@example" } } as Record<string, unknown>;
    const sandbox = buildBackgroundSelf(api) as Record<PropertyKey, unknown>;
    expect(sandbox[Symbol.iterator]).toBeUndefined();
  });
});

/* #560 residual: Tampermonkey 5.5.0 is a Firefox MV2 background
   PAGE: its scripts read document.createElement (a registry module
   loader that appends script tags and waits for onload/onerror),
   document.head, document.body, document.documentElement and
   document.createTextNode (asap setImmediate feature-detects), so
   the documentless sandbox failed the boot with "ReferenceError:
   document is not defined". The stub answers that surface; the
   loader is real (fetch + same-scope eval); stub elements
   deliberately lack onreadystatechange so the asap polyfill keeps
   its MessageChannel branch (a dead DOM branch would hang every
   queued task). */

type BgDoc = {
  readyState: string;
  head: Record<string, unknown>;
  body: Record<string, unknown>;
  createElement: (t: string) => unknown;
  createTextNode: (t: string) => unknown;
};
type BgEl = {
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  parentNode: unknown;
};

describe("background document stub (#560 residual)", () => {
  const g = globalThis as Record<string, unknown>;
  let prevLoc: unknown;
  let hadLoc: boolean;

  beforeEach(() => {
    prevLoc = g.location;
    hadLoc = Object.prototype.hasOwnProperty.call(g, "location");
    g.location = { origin: "https://engine.example" };
  });
  afterEach(() => {
    if (hadLoc) g.location = prevLoc;
    else delete g.location;
  });

  it("createElement answers the inert element surface TM touches", () => {
    const doc = buildBackgroundDocument() as unknown as BgDoc;
    const el = doc.createElement("script") as BgEl;
    el.setAttribute("src", "js/registry.js");
    expect(el.getAttribute("src")).toBe("js/registry.js");
    const head = doc.head as { appendChild: (c: unknown) => unknown };
    expect(head.appendChild(el)).toBe(el);
    expect(el.parentNode).toBe(doc.head);
    expect("onreadystatechange" in el).toBe(false);
    expect(doc.readyState).toBe("complete");
    expect(doc.createTextNode("x")).toEqual({ data: "x", parentNode: null });
  });

  it("the script-tag loader hands src to loadScript and fires onload", async () => {
    const seen: string[] = [];
    let fired = 0;
    const doc = buildBackgroundDocument(async (src: string) => {
      seen.push(src);
    }) as unknown as BgDoc;
    const el = doc.createElement("script") as BgEl;
    el.setAttribute("src", "js/registry.js");
    el.onload = () => {
      fired++;
    };
    (doc.head as { appendChild: (c: unknown) => unknown }).appendChild(el);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["js/registry.js"]);
    expect(fired).toBe(1);
  });

  it("a failed load fires onerror, and a node loads only once", async () => {
    const doc = buildBackgroundDocument(async () => {
      throw new Error("missing");
    }) as unknown as BgDoc;
    let failed = 0;
    const el = doc.createElement("script") as BgEl;
    el.setAttribute("src", "gone.js");
    el.onerror = () => {
      failed++;
    };
    (doc.body as { appendChild: (c: unknown) => unknown }).appendChild(el);
    (doc.body as { appendChild: (c: unknown) => unknown }).appendChild(el);
    await new Promise((r) => setTimeout(r, 10));
    expect(failed).toBe(1);
  });

  it("self answers window/document and keeps unforgeable writes honest", () => {
    const api = { runtime: { id: "tm@example" } } as Record<string, unknown>;
    const doc = buildBackgroundDocument();
    const sandbox = buildBackgroundSelf(api, { document: doc }) as Record<string, unknown>;
    expect(sandbox.window).toBe(sandbox);
    expect(sandbox.document).toBe(doc);
    sandbox.customBag = 7;
    expect(sandbox.customBag).toBe(7);
    sandbox.location = "https://evil.example";
    expect((sandbox.location as { origin: string }).origin).toBe(
      "https://engine.example",
    );
  });
});
