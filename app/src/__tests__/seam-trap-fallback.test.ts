import { describe, expect, it, vi } from "vitest";

/* #633: a trapping seam wasm (live incident: RuntimeError
   unreachable from redact_url_userinfo on a bare-origin header
   value) must degrade to the TS fallback bodies instead of
   throwing into the request pipeline. */
const trap = vi.hoisted(() => ({
  redactSecrets: (): string => {
    throw new Error("RuntimeError: unreachable");
  },
  planTranslation: (): string => {
    throw new Error("RuntimeError: unreachable");
  },
  planEngineCsp: (): string => {
    throw new Error("RuntimeError: unreachable");
  },
}));
vi.mock("../seam", () => ({ activeSeam: () => trap, initSeamWasm: async () => {} }));

import { redactSecrets } from "../diag";
import { planCspTranslation } from "../csp-translation";
import { planEngineCsp } from "../csp-enforce";

describe("seam trap falls back to the TS bodies (#633)", () => {
  it("redactSecrets redacts via the TS chain when the wasm traps", () => {
    expect(redactSecrets("https://u:pw@a.test/?code=x&keep=1")).toBe(
      "https://[redacted]@a.test/?code=[redacted]&keep=1",
    );
  });

  it("planCspTranslation answers with the TS plan when the wasm traps", () => {
    expect(planCspTranslation("img-src a.com")).toBeTruthy();
  });

  it("planEngineCsp answers with the TS plan when the wasm traps", () => {
    const plan = planEngineCsp("img-src a.com", "https://x.test/");
    expect(plan.selfOrigin).toBe("https://x.test");
    expect(plan.enforced).toContain("img-src");
  });
});
