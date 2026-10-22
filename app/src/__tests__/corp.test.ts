import { describe, expect, it } from "vitest";
import swSource from "../sw.ts?raw";
import { withCorp } from "../corp";

/* CORP parity for COEP embedders: withCorp rebuilds every
   engine-served response with CORP: cross-origin at the
   respondWith seam, so split-origin hosts that run COOP/COEP on
   their top document can embed the content-origin frames at all
   (no CORP means ERR_BLOCKED_BY_RESPONSE, an empty chrome-error
   frame). */

describe("withCorp", () => {
  it("adds the CORP header and preserves status, reason and body", async () => {
    const out = withCorp(new Response("body", { status: 200 }));
    expect(out.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(out.status).toBe(200);
    await expect(out.text()).resolves.toBe("body");
  });

  it("keeps existing headers (redirect location survives)", () => {
    const out = withCorp(
      new Response(null, {
        status: 302,
        headers: { location: "/somewhere", "content-type": "text/html" },
      }),
    );
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/somewhere");
    expect(out.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("stays legal on null-body statuses", () => {
    const out = withCorp(new Response(null, { status: 204 }));
    expect(out.status).toBe(204);
    expect(out.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("passes opaque-class responses through untouched", () => {
    const err = Response.error();
    const out = withCorp(err);
    expect(out).toBe(err);
    expect(out.headers.get("cross-origin-resource-policy")).toBeNull();
  });
});

/* Wiring gate (the anchorshim install-order pattern): the fetch
   listener must route every respondWith through withCorp; the
   proxy seam is the only place engine responses can opt into
   embedding, so a silent rewiring in sw.ts is a regression. */
describe("sw fetch wiring", () => {
  it("routes the fetch listener through withCorp", () => {
    expect(swSource).toContain('Promise.resolve(r).then(withCorp)');
    expect(swSource).toContain('addEventListener("fetch"');
    expect(swSource.indexOf("withCorp")).toBeLessThan(
      swSource.indexOf('addEventListener("fetch"'),
    );
  });
});
