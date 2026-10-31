import { describe, expect, it } from "vitest";
import { applyPostMessage, applySenderShim, childProxyByFrame } from "../bootstrap/postmsg";

/* #533 regression: the child-proxy cache must be shared across module
   instances operating on the SAME realm. Production sequence, pinned
   by the v5/v6 browser probes: the top engine page's navguard
   guardChild applies its sender shim (instance A) into a still-loading
   nested engine realm, and that realm's own bootstrap later runs a
   second copy of the module (instance B) whose contentWindow shadow
   skips (the prototype getter already carries __zlCW). Instance A's
   getter then hands out a proxy minted from instance A's module cache
   while the realm's own vorigin relabel mints from instance B's - two
   different proxies for one child, so strict listeners running
   ev.source === iframe.contentWindow failed in every nested engine
   frame. The fix hangs the cache off the child window itself; this test
   reproduces the two-instance shape and demands one identity. */

type AnyRecord = Record<string, any>;

function frameRealm(origin: string) {
  const win: AnyRecord = {
    location: { origin },
    postMessage: () => {},
    addEventListener: () => {},
  };
  win.parent = win; /* top-level realm: the parent half stays inert */
  const leaf: AnyRecord = {
    location: { origin },
    postMessage: () => {},
    addEventListener: () => {},
  };
  leaf.parent = leaf;
  leaf.window = leaf;
  const proto: AnyRecord = {};
  Object.defineProperty(proto, "contentWindow", {
    get() {
      return leaf;
    },
    configurable: true,
    enumerable: true,
  });
  const el: AnyRecord = Object.create(proto);
  win.HTMLIFrameElement = { prototype: proto };
  win.document = { querySelectorAll: (_q: string) => [el] };
  return { win, leaf, proto, el };
}

describe("cross-instance child-proxy identity (#533)", () => {
  it("converges the getter proxy and the relabel proxy when two module instances shim one realm", async () => {
    const pmB = (await import("../bootstrap/postmsg?zlinstance")) as unknown as typeof import("../bootstrap/postmsg");
    const { win: mid, leaf, proto, el } = frameRealm("https://engine.example");

    /* Instance A = the PARENT page's guardChild pass, before the
       realm's own bootstrap exists: it shadows the realm's
       contentWindow getter (and marks it __zlCW). */
    applySenderShim(mid);
    /* The child realm's own bootstrap (instance B): the getter shadow
       skips (already marked), the own postMessage wrap and stash
       apply once. */
    pmB.applyPostMessage(leaf);
    pmB.applyPostMessage(mid);

    /* The live getter serves instance A's mint... */
    const getter = Object.getOwnPropertyDescriptor(proto, "contentWindow")!.get!;
    const viaGetter = getter.call(el);
    /* ...and the realm's own relabel (instance B) must present the very
       same object, not a second mint from a second module cache. */
    const viaRelabel = childProxyByFrame(mid, "https://engine.example", leaf);
    const viaRelabelB = pmB.childProxyByFrame(mid, "https://engine.example", leaf);

    expect(typeof viaGetter).toBe("object");
    expect(viaGetter).toBe(viaRelabel);
    expect(viaRelabel).toBe(viaRelabelB);
    expect(viaGetter).toBe(el.contentWindow);
  });

  it("keeps distinct children on distinct proxies (one child window, one origin key)", async () => {
    const pmB = (await import("../bootstrap/postmsg?zlinstance")) as unknown as typeof import("../bootstrap/postmsg");
    const a = frameRealm("https://engine.example");
    const b = frameRealm("https://engine.example");
    applyPostMessage(a.leaf);
    pmB.applyPostMessage(b.leaf);

    const pa = childProxyByFrame(a.win, "https://engine.example", a.leaf);
    const pb = pmB.childProxyByFrame(b.win, "https://engine.example", b.leaf);
    expect(pa).toBeDefined();
    expect(pb).toBeDefined();
    expect(pa).not.toBe(pb);
  });
});
