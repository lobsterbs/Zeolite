import { existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";

/* Deterministic wasm-glue fallback for TEST runs in environments
   without wasm-pack (local sandboxes). When CI's generated
   app/src/rewriter_wasm/ glue is absent, the transform.ts import of
   ./rewriter_wasm/rewriter_wasm.js resolves to the committed throwing
   stub (src/rewriter_wasm_stub.ts) instead of failing every
   transitively-importing module at load time. Where the real glue
   exists - CI, or a locally built tree - this resolver is inert, and
   the plugin is registered only under vitest, never in production
   builds. */
function wasmGlueTestFallback(): Plugin {
  /* Each entry: the generated glue module (absent without the
     Rust toolchain) and the committed throwing stub that stands
     in for it. Semantics identical to the rewriter-only plugin
     this replaces: substitute the stub only when the generated
     glue is absent. */
  const glues = [
    { suffix: "rewriter_wasm/rewriter_wasm.js", real: "src/rewriter_wasm/rewriter_wasm.js", stub: "./src/rewriter_wasm_stub.ts" },
    { suffix: "seam_wasm/seam_wasm.js", real: "src/seam_wasm/seam_wasm.js", stub: "./src/seam_wasm_stub.ts" },
  ].map((g) => ({ ...g, stubPath: new URL(g.stub, import.meta.url).pathname }));
  return {
    name: "zl-wasm-glue-test-fallback",
    enforce: "pre",
    resolveId(id) {
      for (const g of glues) {
        if (!id.endsWith(g.suffix)) continue;
        if (existsSync(g.real)) return null;
        return g.stubPath;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [wasm(), ...(process.env.VITEST ? [wasmGlueTestFallback()] : [])],
  /* Relative base: the engine bundle must be servable from any subpath
     (LobsterBrowse aliases the dist bundle under /zlsw/). With the
     default "/" base Vite freezes new URL(<asset>, import.meta.url)
     refs to the origin root - under a subpath alias they 404 and every
     proxied document dies silently (commit 6e9d395 fixed the explicit
     calls; the 2.1 subpath gate then caught the same freeze alive in
     the wasm-pack glue fallback). A relative base makes every emitted
     asset ref resolve against the importing script's URL: for sw.js
     that is the service worker script URL, which is exactly where the
     assets sit, under any mount path. */
  base: "./",
  build: {
    // ESM entries only: the SW (a module service worker, see
    // src/engine.ts) and the two HTML entries. The three
    // page/worker-facing artifacts - bootstrap.js (injected as a
    // classic <script src>), worker-prelude.js (prepended to classic
    // worker scripts) and finder.js (eval'd in the page) - cannot
    // carry ESM syntax, and Vite cannot emit per-entry IIFE in one
    // build, so package.json builds them with esbuild after this
    // pass. They must keep their exact filenames: the rewriter
    // injects /bootstrap.js, the SW sibling-fetches worker-prelude.js
    // and finder.js. No hashed filenames anywhere.
    rollupOptions: {
      input: {
        main: "index.html",
        devtools: "devtools.html",
        guestHost: "guest-host.html",
        sw: "src/sw.ts",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
