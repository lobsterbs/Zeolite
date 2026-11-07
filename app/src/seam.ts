/* The wasm seam over the pure Rust ports (#614/#615/#616 wiring):
   zeolite-seam-wasm exposes planTranslation, planEngineCsp,
   parseRulesKdl, parseSiteconfigKdl and redactSecrets as pure
   string-in/JSON-out functions. This module owns ONLY the
   lifecycle: one lazy init, one module reference, no retry.
   Every caller (diag, csp-translation, csp-enforce, rules,
   siteconfig) keeps its TS implementation as the fail-safe
   fallback when activeSeam() returns null, so a missing, older or
   failed module can never regress engine behavior. No DIAG
   import here: diag imports this, and a leaf module cannot log
   into the plane it feeds. */
import * as seamWasm from "./seam_wasm/seam_wasm.js";

export interface SeamWasm {
  planTranslation(raw: string, reportOnly: boolean): string;
  planEngineCsp(raw: string, docUrl: string): string;
  /** null when the KDL parse fails; the loaders map that onto
      their existing "invalid" doctor state. */
  parseRulesKdl(body: string): string | null;
  parseSiteconfigKdl(body: string): string | null;
  redactSecrets(s: string): string;
  /** wasm-pack --target web async init. */
  default(path?: unknown): Promise<unknown>;
}

type Seam = Omit<SeamWasm, "default">;

let seam: Seam | null = null;
let seamInit: Promise<void> | null = null;

/** Instantiate the seam wasm once, at service worker boot. The
    caller owns the rejection (one DIAG row, no retry): the TS
    fallbacks make a failed init a degradation, never an error. */
export function initSeamWasm(): Promise<void> {
  if (!seamInit) {
    seamInit = (async () => {
      const mod = seamWasm as unknown as SeamWasm;
      await mod.default(new URL("seam_wasm_bg.wasm", self.location.href));
      seam = mod;
    })();
  }
  return seamInit;
}

/** The live wasm seam, or null before or without a successful
    init. Callers branch on this and keep their TS body as the
    fallback. */
export function activeSeam(): Seam | null {
  return seam;
}
