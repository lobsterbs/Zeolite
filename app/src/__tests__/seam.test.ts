import { describe, expect, it } from "vitest";
import { activeSeam, initSeamWasm } from "../seam";
import { redactSecrets } from "../diag";

/* The fail-safe contract of the seam module, pinned for BOTH
   environments the test matrix runs in: with the stub (no Rust
   toolchain) init throws, and with the real glue (CI artifact)
   the node test runtime cannot serve the wasm bytes, so init
   rejects there too. Either way the seam must stay null and
   every caller must keep working through its TS body. */
describe("seam wasm fail-safe contract", () => {
  it("stays on the TS fallbacks when the wasm cannot initialize", async () => {
    expect(activeSeam()).toBeNull();
    await expect(initSeamWasm()).rejects.toBeTruthy();
    expect(activeSeam()).toBeNull();
    expect(redactSecrets("https://u:p@x.test/")).toBe("https://[redacted]@x.test/");
  });
});
