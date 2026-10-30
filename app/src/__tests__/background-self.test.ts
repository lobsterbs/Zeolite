import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBackgroundSelf } from "../extensions/background";

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
