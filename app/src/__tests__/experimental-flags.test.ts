import { afterEach, describe, expect, it } from "vitest";
import {
  experimentalSnapshot, experimentalEnabled, resetExperimentalForTests, selectExperimental,
} from "../experimental-flags";

afterEach(resetExperimentalForTests);

describe("experimental flag selection (host preferences, not unsafe runtime features)", () => {
  it("all four default off and none can activate unfinished prototypes", () => {
    expect(experimentalSnapshot().requested).toEqual({
      adaptiveTransit: false, hybridLocation: false,
      cspTranslation: false, virtualSW: false,
    });
    expect(Object.values(experimentalSnapshot().effective)).toEqual([false,false,false,false]);
  });

  it("stores four requested booleans without implying effective execution", () => {
    const ok = selectExperimental({
      adaptiveTransit: true, hybridLocation: true,
      cspTranslation: true, virtualSW: true,
    });
    expect(ok).toEqual({ ok: true });
    expect(Object.values(experimentalSnapshot().requested)).toEqual([true,true,true,true]);
    expect(experimentalSnapshot().effective).toEqual({
      adaptiveTransit: false, hybridLocation: false,
      cspTranslation: true, virtualSW: false,
    });
    expect(experimentalSnapshot().status.adaptiveTransit).toBe("shadow-only");
    expect(experimentalSnapshot().status.cspTranslation).toBe("deny-only");
    expect(experimentalEnabled("cspTranslation")).toBe(true);
    expect(experimentalSnapshot().status.virtualSW).toBe("not-implemented");
  });

  it("updates only supplied allowlisted keys", () => {
    selectExperimental({ virtualSW: true });
    expect(selectExperimental({ cspTranslation: true }).ok).toBe(true);
    expect(experimentalSnapshot().requested).toMatchObject({
      adaptiveTransit: false, hybridLocation: false,
      cspTranslation: true, virtualSW: true,
    });
  });

  it("rejects malformed values/keys atomically; no unsafe prototype fields", () => {
    selectExperimental({ adaptiveTransit: true });
    const before = experimentalSnapshot().requested;
    for (const value of [null, true, [], "true", { adaptiveTransit: "true" },
      { adaptiveTransit: false, undocumented: true },
      JSON.parse('{"__proto__":{"active":true}}'),
      Object.create(null),
    ]) {
      expect(selectExperimental(value).ok).toBe(false);
      expect(experimentalSnapshot().requested).toEqual(before);
    }
    expect(({} as {active?: boolean}).active).toBeUndefined();
  });

  it("snapshots cannot be mutated by caller", () => {
    const snap = experimentalSnapshot();
    snap.requested.adaptiveTransit = true;
    expect(experimentalSnapshot().requested.adaptiveTransit).toBe(false);
  });
});
