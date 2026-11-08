/* Deterministic stand-in for the CI-generated zeolite-cookies-wasm
   glue (the seam_wasm_stub.ts pattern). One deliberate difference:
   EVERY export throws, including the default init. The cookie seam is
   fail-safe, so in test environments initCookiesWasmGlue() must reject
   and every jar seam stays on its TS body in cookies.ts. Where the
   real glue exists (CI), the vite resolver never loads this file. */
function missing(): never {
  throw new Error(
    "zeolite: cookies wasm glue is not generated in this environment " +
      "(build it with: wasm-pack build crates/cookies-wasm --target web " +
      "--release --out-name cookies_wasm, then copy " +
      "crates/cookies-wasm/pkg/cookies_wasm* into app/src/cookies_wasm/).",
  );
}

export function setPsl(): void {
  missing();
}
export function storeBatch(): string {
  return missing();
}
export function matchRequest(): string {
  return missing();
}
export function matchDocument(): string {
  return missing();
}
export function sweep(): string {
  return missing();
}
export function removeIdentities(): number {
  return missing();
}
export function exportNs(): string {
  return missing();
}
export function exportAll(): string {
  return missing();
}
export function replaceNs(): number {
  return missing();
}
export function mergeNs(): string {
  return missing();
}
export function clearNs(): string {
  return missing();
}
export function clearBucket(): number {
  return missing();
}
export function clearAll(): void {
  missing();
}
export default function init(_path?: unknown): Promise<never> {
  return missing();
}
