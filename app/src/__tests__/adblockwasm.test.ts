import { describe, expect, it } from "vitest";
import { initAdblockWasm } from "../adblockwasm";

/* The fail-safe contract of the adblock loader, pinned for BOTH
   environments the test matrix runs in: with the stub (no Rust
   toolchain) the import or init throws, and with the real glue (CI
   artifact) the node test runtime cannot serve the wasm bytes, so
   init rejects there too. Either way the ghostery adapter must keep
   matching through its @ghostery/adblocker TS body. */
describe("adblock wasm loader fail-safe contract (#613)", () => {
  it("rejects when the wasm cannot initialize", async () => {
    await expect(initAdblockWasm()).rejects.toBeTruthy();
  });
});
