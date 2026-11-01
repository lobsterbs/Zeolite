/* #500: a list host that answers 200 with a junk or truncated body
   hands the parser near-zero filters. No fetch failed, so the #381
   load-failure row never fires; without this seam the matcher
   installs silently with a near-zero block rate. The adapter must
   emit one TRANSPORT DIAG naming the condition, never install junk,
   and keep a previously loaded good matcher across a junk refresh. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cap = vi.hoisted(() => ({
  filtersPerLoad: [] as number[],
}));

vi.mock("@ghostery/adblocker", () => ({
  FiltersEngine: {
    fromPrebuiltAdsAndTracking: async () => {
      const count = cap.filtersPerLoad[cap.filtersPerLoad.length - 1] ?? 0;
      return {
        getFilters: () => ({ networkFilters: new Array(count), cosmeticFilters: [] }),
        match: () => ({
          match: true,
          filter: { getHostname: () => "ads.example" },
        }),
      };
    },
  },
  Request: { fromRawDetails: (d: unknown) => d },
}));

vi.mock("../diag", () => ({
  DIAG: { emit: vi.fn(), trace: () => "trace" },
}));

const AD_URL = "https://ads.example/x.js";
const LIST_URL =
  "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ads.json";

interface Fresh {
  configureGhostery: typeof import("../ghostery").configureGhostery;
  ghosteryBlock: typeof import("../ghostery").ghosteryBlock;
  ghosteryLoadInProgress: typeof import("../ghostery").ghosteryLoadInProgress;
  settle: () => void;
  emit: ReturnType<typeof vi.fn>;
}

async function fresh(): Promise<Fresh> {
  vi.resetModules();
  const g = await import("../ghostery");
  const d = await import("../diag");
  const emit = d.DIAG.emit as unknown as ReturnType<typeof vi.fn>;
  emit.mockClear();
  const s = await import("../streams-alive");
  /* #577: the kick gates on the first proxied body having settled. */
  const settle = () => {
    s.streamAlive("https://page.example/doc.html");
    s.streamDone("https://page.example/doc.html");
  };
  return {
    settle,
    configureGhostery: g.configureGhostery,
    ghosteryBlock: g.ghosteryBlock,
    ghosteryLoadInProgress: g.ghosteryLoadInProgress,
    emit,
  };
}

async function load(x: Fresh): Promise<void> {
  x.settle();
  x.ghosteryBlock(LIST_URL, "script");
  /* #577: the idle-gated kick needs two consecutive quiet
     samples 250ms apart, so the first load starts at ~250ms. */
  await new Promise<void>((r) => setTimeout(r, 300));
  const pending = x.ghosteryLoadInProgress();
  if (pending) await pending;
}

function parsedRows(x: Fresh): Array<{ message?: string; category?: string }> {
  return x.emit.mock.calls
    .map((c: unknown[]) => c[0] as { message?: string; category?: string })
    .filter((e) => String(e.message).startsWith("ghostery filter lists parsed"));
}

describe("ghostery empty or partial matcher (#500)", () => {
  beforeEach(() => {
    cap.filtersPerLoad.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 200 body parsing to zero filters emits one DIAG and installs nothing", async () => {
    const x = await fresh();
    cap.filtersPerLoad.push(0);
    x.configureGhostery(() => Promise.resolve(new Response("<html>error page</html>", { status: 200 })));
    await load(x);
    const rows = parsedRows(x);
    expect(rows.length).toBe(1);
    expect(rows[0].message).toContain("0 network filters (empty or partial matcher)");
    expect(rows[0].message).toContain("local rules stay active");
    expect(rows[0].category).toBe("TRANSPORT");
    expect(x.ghosteryBlock(AD_URL, "script")).toBeNull();
  });

  it("a handful of parsed filters counts as partial and never installs", async () => {
    const x = await fresh();
    cap.filtersPerLoad.push(12);
    x.configureGhostery(() => Promise.resolve(new Response("junk", { status: 200 })));
    await load(x);
    expect(parsedRows(x).length).toBe(1);
    expect(parsedRows(x)[0].message).toContain("12 network filters");
    expect(x.ghosteryBlock(AD_URL, "script")).toBeNull();
  });

  it("a real-sized load installs and emits no empty/partial row", async () => {
    const x = await fresh();
    cap.filtersPerLoad.push(1200);
    x.configureGhostery(() => Promise.resolve(new Response("ok", { status: 200 })));
    await load(x);
    expect(parsedRows(x).length).toBe(0);
    const blocked = x.ghosteryBlock(AD_URL, "script");
    expect(blocked).not.toBeNull();
    expect(blocked!.host).toBe("ads.example");
  });

  it("a junk refresh never replaces a previously loaded good matcher", async () => {
    const x = await fresh();
    cap.filtersPerLoad.push(1200);
    x.configureGhostery(() => Promise.resolve(new Response("ok", { status: 200 })));
    await load(x);
    expect(x.ghosteryBlock(AD_URL, "script")).not.toBeNull();
    /* past the 7-day refresh window the next block call refreshes */
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    cap.filtersPerLoad.push(0);
    expect(x.ghosteryBlock(AD_URL, "script")).not.toBeNull();
    /* #577: the refresh kick rides the idle gate too (two quiet
       samples); wait past the confirm poll before reading. */
    await new Promise<void>((r) => setTimeout(r, 300));
    const pending = x.ghosteryLoadInProgress();
    if (pending) await pending;
    const rows = parsedRows(x);
    expect(rows.length).toBe(1);
    expect(rows[0].message).toContain("keeping the previously loaded rules");
    expect(x.ghosteryBlock(AD_URL, "script")).not.toBeNull();
  });
});