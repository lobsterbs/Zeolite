/* Deterministic stand-in for the CI-generated zeolite-adblock wasm
   glue (the seam_wasm_stub.ts pattern). One deliberate difference:
   EVERY export throws, including the class constructor and the
   default init. The adblock seam is fail-safe, so in test
   environments initAdblockWasm() must reject and ghostery matching
   stays on its @ghostery/adblocker TS fallback body. Where the real
   glue exists (CI), the vite resolver never loads this file. */
function missing(): never {
  throw new Error(
    "zeolite: adblock wasm glue is not generated in this environment " +
      "(build it with: wasm-pack build crates/adblock --target web " +
      "--release --out-name adblock_wasm, then copy " +
      "crates/adblock/pkg/adblock_wasm* into app/src/adblock_wasm/).",
  );
}
export class WasmAdblock {
  constructor(_listsJson: string) {
    missing();
  }
}
export default function init(_path?: unknown): Promise<never> {
  return missing();
}
