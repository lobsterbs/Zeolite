/* #613: the Rust/WASM adblock arm inside the ghostery adapter. The
   glue loader is mocked (its fail-safe contract lives in
   adblockwasm.test.ts); only the adapter's own logic runs: arm
   selection, the #500 floor plus canary gating, the sticky
   glue-death pin, the #381 URL surface of the wasm list fetch,
   and the data-URL redirect mapping. The TS matcher is mocked
   exactly the way ghostery.test.ts mocks it. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cap = vi.hoisted(() => ({
  glueFail: null as string | null,
  buildFail: null as string | null,
  inputRules: 131989,
  canary: true,
  inits: 0,
  builds: 0,
  tsLoads: 0,
  urls: [] as string[],
  decisions: new Map<string, string>(),
}));

vi.mock("../adblockwasm", () => ({
  initAdblockWasm: async () => {
    cap.inits += 1;
    if (cap.glueFail) throw new Error(cap.glueFail);
    return {
      WasmAdblock: class {
        constructor(listsJson: string) {
          cap.builds += 1;
          JSON.parse(listsJson);
          if (cap.buildFail) throw new Error(cap.buildFail);
        }
        check_network(url: string): string | null {
          return cap.decisions.get(url) ?? null;
        }
        cosmetic(): string { return "{}"; }
        hidden_css(): string { return ""; }
        input_rules(): number { return cap.inputRules; }
        canary_blocks(): boolean { return cap.canary; }
      },
    };
  },
}));

vi.mock("@ghostery/adblocker", () => ({
  FiltersEngine: {
    parse: async () => {
      cap.tsLoads += 1;
      return {
        getFilters: () => ({ networkFilters: new Array(1200), cosmeticFilters: [] }),
        match: () => ({ match: true, filter: { getHostname: () => "ads.example" } }),
      };
    },
  },
  Request: { fromRawDetails: (d: unknown) => d },
}));

vi.mock("../diag", () => ({ DIAG: { emit: vi.fn(), trace: () => "trace" } }));

import {
  WASM_LIST_URLS,
  configureGhostery,
  ghosteryBlock,
  ghosteryLoadInProgress,
  wasmAdblockEngine,
} from "../ghostery";

interface Fresh {
  configureGhostery: typeof import("../ghostery").configureGhostery;
  ghosteryBlock: typeof import("../ghostery").ghosteryBlock;
  ghosteryLoadInProgress: typeof import("../ghostery").ghosteryLoadInProgress;
  wasmAdblockEngine: typeof import("../ghostery").wasmAdblockEngine;
  emit: ReturnType<typeof vi.fn>;
}

async function fresh(): Promise<Fresh> {
  vi.resetModules();
  cap.urls.length = 0;
  const g = await import("../ghostery");
  const d = await import("../diag");
  const emit = d.DIAG.emit as unknown as ReturnType<typeof vi.fn>;
  emit.mockClear();
  g.configureGhostery((input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    cap.urls.push(raw);
    return Promise.resolve(new Response("ok", { status: 200 }));
  });
  const s = await import("../streams-alive");
  s.streamAlive("https://page.example/doc.html");
  s.streamDone("https://page.example/doc.html");
  return {
    configureGhostery: g.configureGhostery,
    ghosteryBlock: g.ghosteryBlock,
    ghosteryLoadInProgress: g.ghosteryLoadInProgress,
    wasmAdblockEngine: g.wasmAdblockEngine,
    emit,
  };
}

async function load(x: Fresh): Promise<void> {
  x.ghosteryBlock("https://page.example/doc.js", "script");
  /* #577: the idle-gated kick needs two quiet samples 250ms
     apart, so the first load starts at ~250ms. */
  await new Promise<void>((r) => setTimeout(r, 300));
  const pending = x.ghosteryLoadInProgress();
  if (pending) await pending;
}

function rows(x: Fresh, prefix: string): string[] {
  return x.emit.mock.calls
    .map((c: unknown[]) => String((c[0] as { message?: string }).message))
    .filter((m) => m.startsWith(prefix));
}

describe("ghostery wasm arm preference (#613)", () => {
  beforeEach(() => {
    cap.glueFail = null;
    cap.buildFail = null;
    cap.inputRules = 131989;
    cap.canary = true;
    cap.inits = 0;
    cap.builds = 0;
    cap.tsLoads = 0;
    cap.decisions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs the wasm engine in preference and never parses the TS matcher", async () => {
    const x = await fresh();
    await load(x);
    expect(x.wasmAdblockEngine()).not.toBeNull();
    expect(cap.inits).toBe(1);
    expect(cap.builds).toBe(1);
    expect(cap.tsLoads).toBe(0);
    /* The wasm arm fetches exactly the vendored ads+tracking set
       on the trusted origin, each URL once. */
    expect(cap.urls.length).toBe(WASM_LIST_URLS.length);
    expect(new Set(cap.urls).size).toBe(cap.urls.length);
    for (const u of cap.urls) {
      expect(u.startsWith("https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/")).toBe(true);
    }
    cap.decisions.set("https://ad.example/x.js", JSON.stringify({ matched: true, exception: false, redirect: null }));
    expect(x.ghosteryBlock("https://ad.example/x.js", "script")).toEqual({ host: "ad.example" });
    cap.decisions.set("https://miss.example/x.js", JSON.stringify({ matched: false, exception: true, redirect: null }));
    expect(x.ghosteryBlock("https://miss.example/x.js", "script")).toBeNull();
  });

  it("decodes a wasm data-URL redirect into the seam body/contentType shape", async () => {
    const x = await fresh();
    await load(x);
    cap.decisions.set(
      "https://ad.example/gif.js",
      JSON.stringify({ matched: true, exception: false, redirect: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }),
    );
    const hit = x.ghosteryBlock("https://ad.example/gif.js", "script");
    expect(hit).not.toBeNull();
    expect(hit!.redirect).toEqual({ body: expect.stringMatching(/^GIF8/), contentType: "image/gif" });
  });

  it("a canary failure refuses the wasm engine and falls back to the TS matcher", async () => {
    const x = await fresh();
    cap.canary = false;
    await load(x);
    expect(x.wasmAdblockEngine()).toBeNull();
    expect(cap.tsLoads).toBe(1);
    const row = rows(x, "adblock wasm engine parsed");
    expect(row.length).toBe(1);
    expect(row[0]).toContain("canary not blocked");
    expect(row[0]).toContain("falling back to the TS matcher");
    expect(x.ghosteryBlock("https://ads.example/x.js", "script")).toEqual({ host: "ads.example" });
  });

  it("a floor failure (handful of rules) refuses the wasm engine the same way", async () => {
    const x = await fresh();
    cap.inputRules = 12;
    cap.canary = true;
    await load(x);
    expect(x.wasmAdblockEngine()).toBeNull();
    expect(cap.tsLoads).toBe(1);
    const row = rows(x, "adblock wasm engine parsed");
    expect(row.length).toBe(1);
    expect(row[0]).toContain("12 input rules");
  });

  it("a junk wasm round is not sticky: a good refresh installs the wasm engine", async () => {
    const x = await fresh();
    cap.canary = false;
    await load(x);
    expect(x.wasmAdblockEngine()).toBeNull();
    expect(cap.tsLoads).toBe(1);
    cap.canary = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(x.ghosteryBlock("https://ads.example/x.js", "script")).not.toBeNull();
    await new Promise<void>((r) => setTimeout(r, 300));
    const pending = x.ghosteryLoadInProgress();
    if (pending) await pending;
    expect(x.wasmAdblockEngine()).not.toBeNull();
    expect(cap.tsLoads).toBe(1);
    expect(cap.builds).toBe(2);
  });

  it("a failed glue init is sticky: one DIAG row and no second wasm attempt", async () => {
    const x = await fresh();
    cap.glueFail = "no glue";
    await load(x);
    expect(x.wasmAdblockEngine()).toBeNull();
    expect(cap.tsLoads).toBe(1);
    const row = rows(x, "adblock wasm arm unavailable");
    expect(row.length).toBe(1);
    expect(row[0]).toContain("no glue");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(x.ghosteryBlock("https://ads.example/x.js", "script")).not.toBeNull();
    await new Promise<void>((r) => setTimeout(r, 300));
    const pending = x.ghosteryLoadInProgress();
    if (pending) await pending;
    expect(cap.inits).toBe(1);
    expect(cap.tsLoads).toBe(2);
  });

  it("the wasm list URL set is the uBlock Origin default set", () => {
    /* uBlock Origin lists only: the uAssets uBO files plus the
       EasyList and EasyPrivacy subscriptions uBO enables by default.
       No other publisher (Peter Lowe or otherwise) may creep back
       in; a set change fails here. */
    expect(WASM_LIST_URLS.length).toBe(13);
    for (const u of WASM_LIST_URLS) {
      expect(u.endsWith(".txt")).toBe(true);
      expect(u.includes("peter-lowe")).toBe(false);
    }
    for (const f of [
      "easylist.txt",
      "easyprivacy.txt",
      "filters.txt",
      "filters-2020.txt",
      "filters-2021.txt",
      "filters-2022.txt",
      "filters-2023.txt",
      "filters-2024.txt",
      "badware.txt",
      "privacy.txt",
      "quick-fixes.txt",
      "resource-abuse.txt",
      "unbreak.txt",
    ]) {
      expect(WASM_LIST_URLS.some((u) => u.endsWith("/" + f))).toBe(true);
    }
  });
});
