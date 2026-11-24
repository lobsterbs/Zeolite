import { afterEach, describe, expect, it } from "vitest";
import controlSource from "../control.ts?raw";
import swstateSource from "../swstate.ts?raw";
import { withCorp } from "../corp";
import { coiEnabled, setCoi } from "../swstate";

/* COI parity: the coi zl:config arm stamps COEP: credentialless on
   engine-served responses (the same rebuild as the CORP stamp), so
   proxied frame documents join a cross-origin-isolated deployment's
   agent cluster and pages can reach SharedArrayBuffer. Unarmed: no
   COEP head is added. Browsers without credentialless support ignore
   the value and keep today's non-isolated behavior (documented). */

afterEach(() => setCoi(false));

describe("COI stamp (withCorp)", () => {
  it("defaults to unarmed", () => {
    expect(coiEnabled()).toBe(false);
  });

  it("stamps COEP credentialless when armed", () => {
    setCoi(true);
    const out = withCorp(new Response("body", { status: 200 }));
    expect(out.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
    expect(out.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(out.status).toBe(200);
  });

  it("adds no COEP head unarmed", () => {
    const out = withCorp(new Response("body", { status: 200 }));
    expect(out.headers.get("cross-origin-embedder-policy")).toBeNull();
  });

  it("keeps an existing COEP value when unarmed", () => {
    const out = withCorp(
      new Response(null, {
        headers: { "cross-origin-embedder-policy": "require-corp" },
      }),
    );
    expect(out.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it("overrides an existing COEP value when armed", () => {
    setCoi(true);
    const out = withCorp(
      new Response(null, {
        headers: { "cross-origin-embedder-policy": "require-corp" },
      }),
    );
    expect(out.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
  });
});

/* Wiring contracts (the anchorshim install-order pattern): the arm
   must move through the control plane like its sibling knobs, and
   the state must live in swstate - a silent rewiring or a move to
   persistent route-config (this arm is ephemeral by design) is a
   regression. */
describe("coi wiring", () => {
  it("zl:config applies the coi arm beside queryRoutes", () => {
    expect(controlSource).toContain('if (typeof msg.coi === "boolean") setCoi(msg.coi);');
    expect(controlSource).toContain("coi?: boolean;");
  });

  it("swstate holds the ephemeral arm, off by default", () => {
    expect(swstateSource).toContain("let coiArmed = false;");
    expect(swstateSource).toContain("export function setCoi(on: boolean): void {");
  });
});
