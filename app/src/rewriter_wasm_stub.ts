/* Deterministic stand-in for the CI-generated wasm-pack glue.

   CI (transport-seam.yml / ci.yml) builds crates/rewriter with
   wasm-pack and copies the output into app/src/rewriter_wasm/, which
   is gitignored. Environments without the Rust toolchain (local
   sandboxes, air-gapped dev machines) have no glue, and every module
   that transitively imports transform.ts used to die at module load,
   hiding the whole test suite behind a toolchain requirement.

   The test-only resolver in vite.config.ts substitutes THIS module
   when (and only when) the generated glue is absent. Its exports
   throw loudly on use - a wasm-dependent test can never fake-pass -
   and module load sets a global flag that the wasm-gated tests skip
   on (see __tests__/wasm-stub.ts). Where the real glue exists (CI),
   the resolver is inert and this file never loads. */

function missing(): never {
  throw new Error(
    "zeolite: rewriter wasm glue is not generated in this environment " +
      "(build it with: wasm-pack build crates/rewriter --target web --release " +
      "--out-name rewriter_wasm, then copy crates/rewriter/pkg/rewriter_wasm* " +
      "into app/src/rewriter_wasm/). The test resolver substituted the " +
      "throwing stub; wasm-dependent tests skip on this flag.",
  );
}

export class JsRewriter {
  constructor() {
    missing();
  }
}

export class JsCssRewriter {
  constructor() {
    missing();
  }
}

export function rewriteCss(): string {
  return missing();
}

export function rewriteJsBody(): string {
  return missing();
}

export function hasOriginPinningRegex(): boolean {
  return missing();
}

export function globalsStats(): string {
  return missing();
}

/* wasm-pack --target web glue's async init. It must NOT throw:
   transform.ts awaits it before the first rewrite call, and the
   degraded-mode path expects init to succeed on a valid module. The
   flag marks the substitution: a wasm-dependent test can skip on
   `(globalThis as { __ZL_WASM_STUB__?: boolean }).__ZL_WASM_STUB__ === true`
   (e.g. via it.skipIf) instead of failing on the toolchain gap. */
export default function init(): Promise<undefined> {
  (globalThis as { __ZL_WASM_STUB__?: boolean }).__ZL_WASM_STUB__ = true;
  return Promise.resolve(undefined);
}
