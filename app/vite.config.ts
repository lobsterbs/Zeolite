import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
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
    // The SW, the bootstrap, the finder and the devtools page must
    // live at known absolute paths with no hashed filenames:
    // registration, HTML injection, the SW's sibling-fetch of the
    // finder bundle (#29) and navigation reference them.
    rollupOptions: {
      input: {
        main: "index.html",
        devtools: "devtools.html",
        sw: "src/sw.ts",
        bootstrap: "src/bootstrap.ts",
        finder: "src/finder.ts",
        prelude: "src/worker-prelude.ts",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
