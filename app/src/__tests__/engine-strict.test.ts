import { afterEach, describe, expect, it, vi } from "vitest";
import { ZeoliteEngine } from "../engine";

/* #609: navigateOpaque() enforces policy instead of silently
   minting a legacy route in the page realm. A refused mint
   (strict opacity, keyless worker), an unreachable worker (no
   controller) and a malformed reply all reject with the worker's
   named reason; a compat-mode legacy answer is the worker's own
   visible policy choice and resolves. */

interface PortLike {
  postMessage(msg: unknown): void;
  close(): void;
}

function stubController(reply: () => unknown) {
  const ctl = {
    postMessage: (_msg: unknown, ports: PortLike[]) => {
      ports[0].postMessage(reply());
    },
  };
  vi.stubGlobal("navigator", { serviceWorker: { controller: ctl } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ZeoliteEngine.navigateOpaque() strict policy (#609)", () => {
  it("rejects with the worker's reason when the mint is refused", async () => {
    stubController(() => ({ ok: false, error: "mint refused: strict opacity is on and no route key is active (storage degraded)" }));
    await expect(new ZeoliteEngine().navigateOpaque("https://target.example/")).rejects.toThrow("strict opacity");
  });

  it("rejects when there is no controller instead of minting a legacy route", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
    await expect(new ZeoliteEngine().navigateOpaque("https://target.example/")).rejects.toThrow("no controller");
  });

  it("rejects a malformed reply (ok without a route)", async () => {
    stubController(() => ({ ok: true }));
    await expect(new ZeoliteEngine().navigateOpaque("https://target.example/")).rejects.toThrow("no reply");
  });

  it("resolves a compat-mode legacy answer (codec visible in the reply)", async () => {
    stubController(() => ({ ok: true, route: "/j/legacytail", codec: "legacy" }));
    const route = await new ZeoliteEngine().navigateOpaque("https://target.example/");
    expect(route).toBe("/j/legacytail");
  });

  it("resolves a keyed mint", async () => {
    stubController(() => ({ ok: true, route: "/j/keyedtail", codec: "keyed" }));
    const route = await new ZeoliteEngine().navigateOpaque("https://target.example/");
    expect(route).toBe("/j/keyedtail");
  });
});
