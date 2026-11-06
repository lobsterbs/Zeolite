import { describe, expect, it } from "vitest";
import { ZEOLITE_BUILD_ID, ZEOLITE_VERSION, withBuildId } from "../swstate";
import swSource from "../sw.ts?raw";
import controlSource from "../control.ts?raw";
import updatesSource from "../updates.ts?raw";

/* #617: the RUNNING build must be nameable end to end. CI stamps
   VITE_ZEOLITE_BUILD_ID (the workflow run id, the same id the dist
   publish step writes into the "engine bundle: build <id>" commit)
   onto the bundle build step only, so the pristine test-env default
   is the bare version and the composed form is gated here. */

describe("engine build id (#617)", () => {
  it("composes the build id suffix", () => {
    expect(withBuildId("3.0.1 Diamond", "41706739889")).toBe(
      "3.0.1 Diamond (build 41706739889)"
    );
  });

  it("stays bare when the build id is absent or blank", () => {
    expect(withBuildId("3.0.1 Diamond", undefined)).toBe("3.0.1 Diamond");
    expect(withBuildId("3.0.1 Diamond", null)).toBe("3.0.1 Diamond");
    expect(withBuildId("3.0.1 Diamond", "")).toBe("3.0.1 Diamond");
    expect(withBuildId("3.0.1 Diamond", "   ")).toBe("3.0.1 Diamond");
  });

  it("matches the dist commit message format (build <run id>)", () => {
    expect(withBuildId("3.0.1 Diamond", "41706739889")).toMatch(/ \(build \d+\)$/);
  });

  it("stays bare in the pristine test env (CI stamps the build step only)", () => {
    /* vitest mirrors VITE_* env onto import.meta.env: a shell that
       already exports the stamp is honored and stays internally
       consistent; the pristine CI path is the bare string. */
    expect(ZEOLITE_VERSION).toBe(withBuildId("3.0.1 Diamond", ZEOLITE_BUILD_ID));
    if (!import.meta.env.VITE_ZEOLITE_BUILD_ID) {
      expect(ZEOLITE_BUILD_ID).toBe("");
      expect(ZEOLITE_VERSION).toBe("3.0.1 Diamond");
    }
  });

  it("the README ASCII banner logs to the DevTools console on every init", () => {
    expect(swSource).toContain(" _____              ___ __");
    expect(swSource).toContain("/__  /  ___  ____  / (_) /____");
  });
  it("the console banner names the running build (#617)", () => {
    expect(swSource).toContain(
      'console.info("[Zeolite] runtime " + ZEOLITE_VERSION)'
    );
  });

  it("zl:ping names the running build (#617)", () => {
    expect(controlSource).toContain("version: ZEOLITE_VERSION,");
  });

  it("zl:engineUpdate names the running build (#617)", () => {
    expect(updatesSource).toContain("version: ZEOLITE_VERSION }");
  });
});
