import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";

/* The Injector is always on: with no zl:config push, the pristine
   module default must be true. Lives in its own file because the
   other query-shape suites reset the flag in beforeEach; nothing in
   this file touches it, so this reads the module-eval default. */
vi.mock("../transport", () => ({ currentEngine: () => "libcurl" }));

import { queryRoutesEnabled } from "../swstate";

describe("injector default (always on)", () => {
  it("query-shape routes are enabled with no config push", () => {
    expect(queryRoutesEnabled()).toBe(true);
  });
});
