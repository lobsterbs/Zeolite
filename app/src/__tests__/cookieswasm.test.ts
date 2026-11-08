import { describe, expect, it } from "vitest";
import { initCookiesWasmGlue } from "../cookieswasm";

/* The fail-safe contract of the cookies loader, pinned for BOTH
   environments the test matrix runs in: with the stub (no Rust
   toolchain) the init throws, and with the real glue (CI artifact)
   the node test runtime cannot serve the wasm bytes, so init rejects
   there too. Either way cookies.ts keeps every jar seam on its TS
   fallback body. */
describe("cookies wasm loader fail-safe contract (#614)", () => {
  it("rejects when the wasm cannot initialize", async () => {
    await expect(initCookiesWasmGlue()).rejects.toBeTruthy();
  });
});
