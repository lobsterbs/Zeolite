/* #456 gate 4: the automatic targeting flag defaults ON. Pinned in
   its own pristine-import file (the suite file resets the flag and
   the store in beforeEach), the queryroute-default precedent. */

import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { locationTargetingEnabled } from "../swstate";

it("automatic location targeting defaults on (#456 gate 4)", () => {
  expect(locationTargetingEnabled()).toBe(true);
});
