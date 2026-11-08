import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #551 second slice: the SW-side zl:cosmeticTokens handler. The
   rules and ghostery modules are mocked (the real engines are
   covered by cosmetic-injection and the wasm suites); the handler
   is exercised through fake ExtendableMessageEvents with a fake
   reply port, and the one-bounded-DIAG-per-client contract is
   asserted against the real DIAG ring. */

const h = vi.hoisted(() => ({
  enabled: true,
  allowlisted: false,
  override: null as { adblock?: boolean } | null,
  tsEngine: null as unknown,
  wasmEngine: null as unknown,
}));

vi.mock("../codec", () => ({
  /* Only the proxied route path decodes; every other client URL
     (devtools, host) is not a proxied document. */
  decodeClientUrl: (u: URL) => (u.pathname === "/r/page" ? "https://page.example/page.html" : null),
}));

vi.mock("../rules", () => ({
  isRulesEnabled: () => h.enabled,
  allowlistedHostFor: () => (h.allowlisted ? "allow.example" : null),
  siteOverrideFor: () => h.override,
  loadRules: async () => ({}),
  compileRules: () => ({}),
}));

vi.mock("../ghostery", () => ({
  ghosteryEngine: () => h.tsEngine,
  wasmAdblockEngine: () => h.wasmEngine,
  requestType: () => "sub_frame",
  WASM_LIST_URLS: [],
  ghosteryLoadInProgress: () => null,
  configureGhostery: () => {},
  ghosteryBlock: () => null,
}));

import { handleCosmeticTokens } from "../cosmetic-tokens";
import { DIAG } from "../diag";

interface FakeEvent {
  ev: ExtendableMessageEvent;
  replies: Record<string, unknown>[];
}

let seq = 0;

function fakeEvent(data: unknown, clientPath = "/r/page", id?: string): FakeEvent {
  seq += 1;
  const replies: Record<string, unknown>[] = [];
  const port = {
    postMessage: (d: unknown) => replies.push(d as Record<string, unknown>),
    close(): void {},
  };
  const ev = {
    data,
    ports: [port],
    source: { id: id ?? "cid-" + seq, url: "https://engine.test" + clientPath },
  } as unknown as ExtendableMessageEvent;
  return { ev, replies };
}

describe("handleCosmeticTokens (#551)", () => {
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    h.enabled = true;
    h.allowlisted = false;
    h.override = null;
    h.tsEngine = null;
    h.wasmEngine = null;
    emit = vi.spyOn(DIAG, "emit") as unknown as ReturnType<typeof vi.fn>;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a sender that is not a proxied route gets off and no state, no DIAG", async () => {
    const { ev, replies } = fakeEvent({ classes: ["a"], ids: [] }, "/devtools");
    await handleCosmeticTokens(ev);
    expect(replies.length).toBe(1);
    expect(replies[0]).toEqual({ ok: true, off: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("a missing port or source never crashes", async () => {
    await handleCosmeticTokens({ data: {}, ports: [], source: null } as unknown as ExtendableMessageEvent);
    await handleCosmeticTokens({ data: {}, ports: [], source: { id: "x", url: "https://engine.test/r/page" } } as unknown as ExtendableMessageEvent);
  });

  it("the done report emits exactly one bounded DIAG row and clears the client", async () => {
    const { ev, replies } = fakeEvent({ applied: 3, done: true });
    await handleCosmeticTokens(ev);
    expect(replies[0]).toEqual({ ok: true, done: true });
    expect(emit).toHaveBeenCalledTimes(1);
    const row = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.category).toBe("REWRITE");
    expect(String(row.message)).toContain("done");
    expect(String(row.message)).not.toContain("a {");
  });

  it("disabled rules, an allowlisted host and a per-site override all refuse with off", async () => {
    h.enabled = false;
    const a = fakeEvent({ classes: ["a"], ids: [] });
    await handleCosmeticTokens(a.ev);
    expect(a.replies[0]).toEqual({ ok: true, off: true });

    h.enabled = true;
    h.allowlisted = true;
    const b = fakeEvent({ classes: ["a"], ids: [] });
    await handleCosmeticTokens(b.ev);
    expect(b.replies[0]).toEqual({ ok: true, off: true });

    h.allowlisted = false;
    h.override = { adblock: false };
    const c = fakeEvent({ classes: ["a"], ids: [] });
    await handleCosmeticTokens(c.ev);
    expect(c.replies[0]).toEqual({ ok: true, off: true });
    /* One refusal DIAG per client, never one per message. */
    const d = fakeEvent({ classes: ["a"], ids: [] });
    await handleCosmeticTokens(d.ev);
    await handleCosmeticTokens(d.ev);
    const refusedRows = emit.mock.calls.filter((c2) => String(c2[0].message).includes("refused"));
    expect(refusedRows.length).toBe(4);
  });

  it("the wasm arm answers hidden_css with the derived doc URL and bounded JSON", async () => {
    const hidden = vi.fn((_url: string, _classes: string, _ids: string) => ".dyn-ad{display:none!important}");
    h.wasmEngine = { hidden_css: hidden, cosmetic: () => JSON.stringify({ active: true, style: "", unsupported: 0 }) };
    const { ev, replies } = fakeEvent({ classes: ["ad-box", "side"], ids: ["hero"] });
    await handleCosmeticTokens(ev);
    expect(replies[0]).toEqual({ ok: true, styles: ".dyn-ad{display:none!important}" });
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(hidden.mock.calls[0]![0]).toBe("https://page.example/page.html");
    expect(JSON.parse(hidden.mock.calls[0]![1] as string)).toEqual(["ad-box", "side"]);
    expect(JSON.parse(hidden.mock.calls[0]![2] as string)).toEqual(["hero"]);
  });

  it("the TS arm queries the DOM-anchored generic rules only", async () => {
    const getCosmeticsFilters = vi.fn((_opts: Record<string, unknown>) => ({ active: true, styles: ".gen{display:none!important}" }));
    h.tsEngine = { getCosmeticsFilters };
    const { ev, replies } = fakeEvent({ classes: ["gen"], ids: [] });
    await handleCosmeticTokens(ev);
    expect(replies[0]).toEqual({ ok: true, styles: ".gen{display:none!important}" });
    const opts = getCosmeticsFilters.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.url).toBe("https://page.example/page.html");
    expect(opts.getRulesFromDOM).toBe(true);
    expect(opts.getBaseRules).toBe(false);
    expect(opts.getRulesFromHostname).toBe(false);
    expect(opts.getInjectionRules).toBe(false);
    expect(opts.getExtendedRules).toBe(false);
    expect(opts.classes).toEqual(["gen"]);
  });

  it("no engine yet answers pending (the runtime retries once)", async () => {
    const { ev, replies } = fakeEvent({ classes: ["a"], ids: [] });
    await handleCosmeticTokens(ev);
    expect(replies[0]).toEqual({ ok: true, pending: true });
  });

  it("oversized token arrays truncate to the caps before the engine sees them", async () => {
    const getCosmeticsFilters = vi.fn((_opts: Record<string, unknown>) => ({ active: true, styles: "" }));
    h.tsEngine = { getCosmeticsFilters };
    const big = [];
    for (let i = 0; i < 6000; i++) big.push("c" + i);
    const { ev } = fakeEvent({ classes: big, ids: big });
    await handleCosmeticTokens(ev);
    const opts = getCosmeticsFilters.mock.calls[0]![0] as Record<string, unknown>;
    expect((opts.classes as string[]).length).toBeLessThanOrEqual(512);
    expect((opts.ids as string[]).length).toBeLessThanOrEqual(128);
  });

  it("the query budget refuses after 24 queries with one DIAG row", async () => {
    const getCosmeticsFilters = vi.fn((_opts: Record<string, unknown>) => ({ active: true, styles: "" }));
    h.tsEngine = { getCosmeticsFilters };
    const first = fakeEvent({ classes: [], ids: [] }, "/r/page", "cid-budget");
    for (let i = 0; i < 24; i++) await handleCosmeticTokens(first.ev);
    expect(getCosmeticsFilters).toHaveBeenCalledTimes(24);
    const over = fakeEvent({ classes: [], ids: [] }, "/r/page", "cid-budget");
    await handleCosmeticTokens(over.ev);
    expect(over.replies[0]).toEqual({ ok: true, off: true });
    expect(getCosmeticsFilters).toHaveBeenCalledTimes(24);
    const budgetRows = emit.mock.calls.filter((c) => String(c[0].message).includes("budget"));
    expect(budgetRows.length).toBe(1);
  });

  it("a done report ignores token fields (no engine query on the final report)", async () => {
    const getCosmeticsFilters = vi.fn((_opts: Record<string, unknown>) => ({ active: true, styles: "" }));
    h.tsEngine = { getCosmeticsFilters };
    const { ev } = fakeEvent({ classes: ["sneaky"], ids: ["x"], done: true });
    await handleCosmeticTokens(ev);
    expect(getCosmeticsFilters).not.toHaveBeenCalled();
  });
});
