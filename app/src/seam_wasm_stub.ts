/* Deterministic stand-in for the CI-generated zeolite-seam-wasm
   glue (the rewriter_wasm_stub.ts pattern). One deliberate
   difference: EVERY export throws, including the default init.
   The seam contract is fail-safe, so in test environments
   initSeamWasm() must reject and activeSeam() must stay null,
   keeping every caller on its TS fallback body. Where the real
   glue exists (CI), the vite resolver never loads this file. */
function missing(): never {
  throw new Error(
    "zeolite: seam wasm glue is not generated in this environment " +
      "(build it with: wasm-pack build crates/seam-wasm --target web " +
      "--release --out-name seam_wasm, then copy " +
      "crates/seam-wasm/pkg/seam_wasm* into app/src/seam_wasm/).",
  );
}

export function planTranslation(): string {
  return missing();
}
export function planEngineCsp(): string {
  return missing();
}
export function parseRulesKdl(): string | null {
  return missing();
}
export function parseSiteconfigKdl(): string | null {
  return missing();
}
export function redactSecrets(): string {
  return missing();
}
export default function init(): Promise<never> {
  return missing();
}
