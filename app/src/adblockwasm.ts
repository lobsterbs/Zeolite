/* #613: lazy loader for the CI-generated zeolite-adblock wasm glue
   (Brave's adblock-rust compiled by wasm-pack). The glue MODULE is
   statically imported (the SW-scope loading lint forbids dynamic
   import() in SW-reachable code; Chromium has no import() on
   ServiceWorkerGlobalScope), but the glue's default() only FETCHES
   the wasm binary and instantiates its linear memory when called:
   that happens lazily at the first filter-list load (ghostery.ts
   loadEngine behind the #577 idle gate), never at worker boot - no
   2 MiB-class download joins the boot path. One lazy init, no
   retry - the seam.ts lifecycle pattern: a failed init keeps
   every caller on its @ghostery/adblocker TS fallback body. No
   DIAG import here: ghostery owns the diagnostics for the arm it
   selects. */
import * as adblockWasm from "./adblock_wasm/adblock_wasm.js";

export interface WasmAdblockLike {
  /** JSON NetworkDecision, or null on an unparsable URL. */
  check_network(url: string, source: string, cpt: string, method: string): string | null;
  /** JSON CosmeticDecision for the page URL. */
  cosmetic(url: string): string;
  /** Generic class/id hide rules for pages without generichide. */
  hidden_css(url: string, classes_json: string, ids_json: string): string;
  /** Non-comment, non-header rule count (the #500 floor input). */
  input_rules(): number;
  /** True only when a real list parsed (the canary probe). */
  canary_blocks(): boolean;
}
export interface AdblockWasmGlue {
  WasmAdblock: new (listsJson: string) => WasmAdblockLike;
  /** wasm-pack --target web async init. */
  default(path?: unknown): Promise<unknown>;
}
let glueInit: Promise<AdblockWasmGlue> | null = null;
/** Instantiate the adblock wasm glue once, lazily. The caller owns
    the rejection (ghostery.ts emits one DIAG row and pins the TS
    matcher); a rejected init is memoized, so later attempts ride
    the same settled promise and never re-init. */
export function initAdblockWasm(): Promise<AdblockWasmGlue> {
  if (!glueInit) {
    glueInit = (async () => {
      const mod = adblockWasm as unknown as AdblockWasmGlue;
      await mod.default(new URL("adblock_wasm_bg.wasm", self.location.href));
      return mod;
    })();
  }
  return glueInit;
}
