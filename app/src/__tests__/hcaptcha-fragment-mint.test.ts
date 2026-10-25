import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleControlEvent, type ControlMessage } from "../control";
import { b64uEncode, decodePath, encodeDest, setRouteKey, setScheme } from "../codec";
import { routeReady, virtualHcaptchaFrameFragment } from "../request";
import { VCTX } from "../swstate";
import { establishContext } from "../vctx";
import { mintRoute } from "../bootstrap/mint";

const ENGINE = "https://engine.example";
const PAGE = "https://shop.example/account";
const KEY = b64uEncode(Uint8Array.from({ length: 16 }, (_, i) => i));
const FRAME = "https://newassets.hcaptcha.com/captcha/v1/hash/static/hcaptcha.html?theme=dark&keep=%2f+%20#frame=challenge&host=engine.example&sitekey=fixture&keep=a%2Bb+%2f";
const FIXED = FRAME.replace("host=engine.example", "host=shop.example");
const deps = { ready: Promise.resolve(), persistRoute: async () => {} };
const routeFor = (dest: string) => {
  const hash = dest.indexOf("#");
  return hash < 0 ? encodeDest(dest) : encodeDest(dest.slice(0, hash)) + dest.slice(hash);
};

beforeEach(async () => {
  await routeReady; setScheme("/j/"); setRouteKey(KEY); VCTX.clear();
  vi.stubGlobal("self", { location: { origin: ENGINE } });
});
afterEach(() => vi.unstubAllGlobals());

async function mint(sourceUrl: string, target = FRAME, claimedOrigin?: string) {
  const replies: Array<{ ok?: boolean; route?: string }> = [];
  const msg = { type: "zl:mint", dest: target, origin: claimedOrigin } as ControlMessage;
  await handleControlEvent({
    data: msg, source: { id: "captcha-parent", url: sourceUrl },
    ports: [{ postMessage: (r: { ok?: boolean; route?: string }) => replies.push(r), close: () => {} }],
  } as unknown as ExtendableMessageEvent, deps);
  expect(replies).toHaveLength(1); expect(replies[0].ok).toBe(true);
  return replies[0].route;
}

describe("hCaptcha fragment identity at the verified mint boundary", () => {
  it("normalizes from the sender route and preserves unrelated query/hash bytes", async () => {
    const route = await mint(ENGINE + encodeDest(PAGE));
    expect(route).toBe(routeFor(FIXED));
    expect(virtualHcaptchaFrameFragment(FRAME, ENGINE, PAGE)).toBe(FIXED);
    expect(new URL(route!, ENGINE).hash).toBe(new URL(FIXED).hash);
    const networkTarget = decodePath(new URL(route!, ENGINE).pathname);
    expect(networkTarget).toBe(FRAME.split("#")[0]);
    expect(networkTarget).not.toContain("#");
    expect(route).not.toContain("https://newassets.hcaptcha.com");
    expect(route).not.toContain(PAGE);
  });

  it("can use the sender's engine-held context after a route token expires", async () => {
    establishContext(VCTX, "captcha-parent", PAGE);
    expect(await mint(ENGINE + "/j/expired-token")).toBe(routeFor(FIXED));
  });

  it("ignores a claimed page origin when the browser source has no virtual identity", async () => {
    expect(await mint(ENGINE + "/", FRAME, PAGE)).toBe(routeFor(FRAME));
  });

  it("uses verified source identity instead of a conflicting claimed origin", async () => {
    expect(await mint(ENGINE + encodeDest(PAGE), FRAME, "https://impostor.example")).toBe(routeFor(FIXED));
  });

  it("keeps non-provider paths, lookalike hosts and non-engine host values unchanged", () => {
    for (const target of [
      FRAME.replace("newassets.hcaptcha.com", "newassets.hcaptcha.com.evil.example"),
      FRAME.replace("/captcha/", "/other/"),
      FRAME.replace("/hcaptcha.html", "/other.html"),
      FRAME.replace("host=engine.example", "host=already-correct.example"),
      FRAME.replace("host=engine.example", "host=engine.example.evil"),
      FRAME.replace("host=engine.example", "host=%ZZ"),
    ]) expect(virtualHcaptchaFrameFragment(target, ENGINE, PAGE)).toBe(target);
  });

  it("receives the full fragment through the real bootstrap mint client", async () => {
    let received: unknown;
    vi.stubGlobal("navigator", { serviceWorker: { controller: {
      postMessage(msg: unknown, ports: MessagePort[]) {
        received = msg;
        ports[0].postMessage({ ok: true, route: "/j/test-route#kept" });
      },
    } } });
    expect(await mintRoute(FRAME)).toBe("/j/test-route#kept");
    expect(received).toEqual({ type: "zl:mint", dest: FRAME });
  });

  it("keeps ordinary runtime anchor/SVG fragments outside the encoded request target", async () => {
    for (const [base, fragment] of [
      ["https://assets.example/icons.svg", "#symbol-1"],
      ["https://assets.example/icons.svg?q=%23keep", "#one%20two"],
      ["https://assets.example/anchor", "#"],
      ["https://assets.example/anchor", "#alpha#beta"],
    ]) {
      const route = await mint(ENGINE + encodeDest(PAGE), base + fragment);
      expect(route).toBe(encodeDest(base) + fragment);
      expect(decodePath(new URL(route!, ENGINE).pathname)).toBe(base);
    }
  });
});
