/* #577: the lazy list-load kick defers to the first transport-idle
   gap so a wedged list origin cannot cost the triggering request its
   first-byte deadline. The loadstate counter is the real one the
   transport seam feeds, and streamAlive/streamDone are the real
   pair the body pumps feed, so the gate runs end to end; the list
   fetch hangs like a filtered network so the in-progress promise is
   observable without racing a completing load. The kick needs two
   consecutive quiet samples a poll interval apart and the first
   proxied body settled, so the timings below allow the confirm
   poll to run. */

import { describe, expect, it, vi } from "vitest";

vi.mock("@ghostery/adblocker", () => ({
  FiltersEngine: {
    /* calls the configured fetcher like the real prebuilt loader, so
       the hanging test fetch keeps the load observably in progress */
    fromPrebuiltAdsAndTracking: async (f: typeof fetch) => {
      await f(
        "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ads.json",
        { method: "GET" },
      );
      return {
        getFilters: () => ({ networkFilters: new Array(1200), cosmeticFilters: [] }),
        match: () => ({ match: false }),
      };
    },
  },
  Request: { fromRawDetails: (d: unknown) => d },
}));

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

type Streams = typeof import("../streams-alive");

async function fresh(): Promise<{ ghostery: typeof import("../ghostery"); loadstate: typeof import("../loadstate"); streams: Streams }> {
  vi.resetModules();
  return {
    ghostery: await import("../ghostery"),
    loadstate: await import("../loadstate"),
    streams: await import("../streams-alive"),
  };
}

/* The first proxied body having settled; the real pair the body
   pumps call, so the gate sees a genuinely served page. */
function settle(s: Streams): void {
  s.streamAlive("https://page.example/doc.html");
  s.streamDone("https://page.example/doc.html");
}

describe("ghostery idle-gated list load (#577)", () => {
  it("holds the kick until the engine has served its first proxied body", async () => {
    const { ghostery, streams } = await fresh();
    ghostery.configureGhostery(() => new Promise<Response>(() => {}));
    expect(ghostery.ghosteryBlock("https://page.example/x.js", "script")).toBeNull();
    await tick(700);
    /* every counter reads zero in the boot window; only a settled
       body proves a page was served and the kick may start */
    expect(ghostery.ghosteryLoadInProgress()).toBeNull();
    settle(streams);
    await tick(700);
    expect(ghostery.ghosteryLoadInProgress()).not.toBeNull();
  });

  it("starts the list load on the first idle gap, never inline", async () => {
    const { ghostery, streams } = await fresh();
    ghostery.configureGhostery(() => new Promise<Response>(() => {}));
    settle(streams);
    expect(ghostery.ghosteryBlock("https://page.example/x.js", "script")).toBeNull();
    expect(ghostery.ghosteryLoadInProgress()).toBeNull();
    await tick(300);
    expect(ghostery.ghosteryLoadInProgress()).not.toBeNull();
  });

  it("holds the kick while an upstream request awaits its first byte", async () => {
    const { ghostery, loadstate, streams } = await fresh();
    ghostery.configureGhostery(() => new Promise<Response>(() => {}));
    settle(streams);
    loadstate.loadEnter("https://page.example/doc.html");
    expect(ghostery.ghosteryBlock("https://page.example/x.js", "script")).toBeNull();
    await tick(700);
    expect(ghostery.ghosteryLoadInProgress()).toBeNull();
    loadstate.loadLeave("https://page.example/doc.html");
    await tick(700);
    expect(ghostery.ghosteryLoadInProgress()).not.toBeNull();
  });

  it("holds the kick while a rewritten body stream is still pumping", async () => {
    const { ghostery, streams } = await fresh();
    ghostery.configureGhostery(() => new Promise<Response>(() => {}));
    streams.streamAlive("https://page.example/doc.html");
    expect(ghostery.ghosteryBlock("https://page.example/x.js", "script")).toBeNull();
    await tick(700);
    expect(ghostery.ghosteryLoadInProgress()).toBeNull();
    streams.streamDone("https://page.example/doc.html");
    await tick(700);
    expect(ghostery.ghosteryLoadInProgress()).not.toBeNull();
  });

  it("backs the failed-load cooldown off instead of bursting every minute", async () => {
    const { ghostery, streams } = await fresh();
    settle(streams);
    vi.doMock("@ghostery/adblocker", () => ({
      FiltersEngine: {
        fromPrebuiltAdsAndTracking: async (f: typeof fetch) => {
          await f(
            "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ads.json",
            { method: "GET" },
          );
          throw new Error("list origin unreachable");
        },
      },
      Request: { fromRawDetails: (d: unknown) => d },
    }));
    vi.resetModules();
    const streams2 = await import("../streams-alive");
    const fresh2 = await import("../ghostery");
    fresh2.configureGhostery(() => Promise.reject(new Error("unreachable")));
    /* a fresh module pair: the gate sees a settled body again */
    settle(streams2);
    expect(fresh2.ghosteryBlock("https://page.example/x.js", "script")).toBeNull();
    await tick(300);
    /* the load ran and failed; the backoff keeps a re-kick from
       firing while the cooldown holds (second block, quiet, still
       no new load) */
    expect(fresh2.ghosteryLoadInProgress()).toBeNull();
    fresh2.ghosteryBlock("https://page.example/y.js", "script");
    await tick(700);
    expect(fresh2.ghosteryLoadInProgress()).toBeNull();
    void ghostery;
  });
});
