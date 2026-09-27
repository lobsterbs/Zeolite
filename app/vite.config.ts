import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
  build: {
    // The SW, the bootstrap and the devtools page must live at known
    // absolute paths with no hashed filenames: registration, HTML
    // injection and navigation reference them.
    rollupOptions: {
      input: {
        main: "index.html",
        devtools: "devtools.html",
        sw: "src/sw.ts",
        bootstrap: "src/bootstrap.ts",
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
