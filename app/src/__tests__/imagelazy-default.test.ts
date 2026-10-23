import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

/* Lazy images are always on (#413): with no zl:config push, the
   pristine module default must be true - the flag is ephemeral and
   an idle-restarted worker instance would otherwise silently turn
   the rewrite pass off. Own file: the other suites reset the flag
   in beforeEach; this one reads the module-eval default. */
vi.mock("../transport", () => ({ currentEngine: () => "libcurl" }));

import { isImageLazy } from "../swstate";

describe("lazy images default (always on)", () => {
  it("the rewrite pass is enabled with no config push", () => {
    expect(isImageLazy()).toBe(true);
  });
});
