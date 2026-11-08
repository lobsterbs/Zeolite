/* #613: the wasm arm of the cosmetic document seam. ../ghostery is
   mocked (arm preference lives in ghostery-wasm-arm.test.ts);
   the fake WasmAdblockLike answers from a canned cosmetic JSON
   in exactly the shape the CI-built Rust engine returns, so
   only the adapter's own mapping runs. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const cap = vi.hoisted(() => {
  const state = { cosmeticJson: "{}" };
  const wasm = {
    check_network: (): string | null => null,
    cosmetic: (_url: string): string => state.cosmeticJson,
    hidden_css: (): string => "",
    input_rules: (): number => 131989,
    canary_blocks: (): boolean => true,
  };
  return { state, wasm };
});

vi.mock("../ghostery", () => ({
  ghosteryEngine: () => null,
  wasmAdblockEngine: () => cap.wasm,
  requestType: (type: string, destination?: string) =>
    destination === "iframe" || destination === "frame" ? "sub_frame" : "document",
  ghosteryBlock: () => null,
  WASM_LIST_URLS: [],
}));

vi.mock("../diag", () => ({ DIAG: { emit: vi.fn(), trace: () => "trace" } }));

import { DIAG } from "../diag";
import { COSMETIC_STYLE_CAP, ghosteryCosmeticsForDocument } from "../cosmetics";
import { compileRules, rulesResetForTests } from "../rules";

function rows(): Array<{ message: string; category: string; severity: string }> {
  return (DIAG.emit as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => c[0] as { message: string; category: string; severity: string })
    .filter((e) => e.message.startsWith("adblock wasm cosmetic styles"));
}

describe("cosmetics wasm arm (#613)", () => {
  beforeEach(() => {
    rulesResetForTests();
    cap.state.cosmeticJson = "{}";
    (DIAG.emit as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it("injects the page-specific selectors and labels the engine honestly", async () => {
    cap.state.cosmeticJson = JSON.stringify({
      active: true,
      style: ".ad{display:none!important}" + String.fromCharCode(10),
      unsupported: 2,
      generichide: false,
    });
    const tag = await ghosteryCosmeticsForDocument(compileRules({}), "https://cosm.example/page", "document");
    expect(tag).toContain("data-zl-cosmetic");
    expect(tag).toContain(".ad");
    const row = rows();
    expect(row.length).toBe(1);
    expect(row[0].category).toBe("REWRITE");
    expect(row[0].severity).toBe("info");
    expect(row[0].message).toContain("for document");
    expect(row[0].message).toContain("1 applied");
    expect(row[0].message).toContain("2 unsupported");
    /* No generic base stylesheet rides the wasm arm: the wording
       must not claim one. */
    expect(row[0].message).not.toContain("+base stylesheet");
    expect(row[0].message).not.toContain(".ad");
  });

  it("an inactive decision yields no tag and no event", async () => {
    cap.state.cosmeticJson = JSON.stringify({ active: false, style: "", unsupported: 0, generichide: false });
    const tag = await ghosteryCosmeticsForDocument(compileRules({}), "https://quiet.example/page", "document");
    expect(tag).toBe("");
    expect(rows().length).toBe(0);
  });

  it("a wasm engine answering junk JSON is refused, not injected", async () => {
    cap.state.cosmeticJson = "not json";
    const tag = await ghosteryCosmeticsForDocument(compileRules({}), "https://cosm.example/page", "document");
    expect(tag).toBe("");
    expect(rows().length).toBe(0);
  });

  it("truncates the wasm stylesheet at the cap and reports it", async () => {
    const nl = String.fromCharCode(10);
    let style = "";
    for (let i = 0; i < 6000; i++) style += ".s" + i + "{display:none!important}" + nl;
    cap.state.cosmeticJson = JSON.stringify({ active: true, style, unsupported: 0, generichide: false });
    const tag = await ghosteryCosmeticsForDocument(compileRules({}), "https://cosm.example/page", "document");
    expect(tag).toContain("data-zl-cosmetic");
    const row = rows();
    expect(row.length).toBe(1);
    expect(row[0].message).toContain("truncated at " + COSMETIC_STYLE_CAP + " bytes");
  });
});
