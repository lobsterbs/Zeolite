import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const upstream = vi.hoisted(() => ({ requests: [] as Array<{ url: string; headers: Headers }> }));
vi.mock("../transport", () => ({
  currentEngine: () => "libcurl",
  wispTransport: {
    ready: async () => {},
    fetch: async (url: string, init: RequestInit) => {
      upstream.requests.push({ url, headers: new Headers(init.headers) });
      return new Response("fixture response", { headers: { "content-type": "text/plain" } });
    },
  },
}));
/* This request/headers fixture does not run the browser-only rewriter. */
vi.mock("../transform", () => ({
  isHtml: () => false, isCss: () => false, isJs: () => false,
  rewriteStream: () => { throw new Error("unexpected rewrite"); },
  cssRewriteStream: () => { throw new Error("unexpected rewrite"); },
  rewriteJsBody: async (s: string) => s, workerPrelude: async () => "", rawFrom: () => null,
}));
import { forwardedHeaders, handleFetch, routeReady, virtualRecaptchaCo, virtualHcaptchaHost, virtualOgsOrigin } from "../request";
import { b64uEncode, buildQueryHandleUrl, encodeDestLegacy, setRouteKey, setScheme } from "../codec";
import { establishContext } from "../vctx";
import { VCTX } from "../swstate";
const ENGINE = "https://engine.example";
const PAGE = "https://shop.example/account?next=%2Fmail&x=1&x=2";
const KEY = b64uEncode(Uint8Array.from({ length: 16 }, (_, i) => i));
const co = (origin: string) => btoa(origin).replace(/=+$/, (p) => ".".repeat(p.length));
const recaptcha = "https://www.google.com/recaptcha/api2/anchor?co=" + co(ENGINE + ":443") + "&k=fixture";
const hcaptcha = "https://api.hcaptcha.com/checksiteconfig?host=engine.example&sitekey=fixture";
const ogs = "https://ogs.google.com/widget/app/so?origin=" + encodeURIComponent(ENGINE);
let clientUrl: string | null;
beforeEach(async () => {
  await routeReady;
  setScheme("/j/"); setRouteKey(KEY); VCTX.clear(); upstream.requests = []; clientUrl = null;
  vi.stubGlobal("self", {
    location: { origin: ENGINE }, registration: { scope: ENGINE + "/" },
    clients: { get: async () => clientUrl ? { id: "widget-page", url: clientUrl } : null },
  });
  vi.stubGlobal("caches", { open: async () => ({ match: async () => undefined, put: async () => {}, keys: async () => [] }) });
});
afterEach(() => vi.unstubAllGlobals());
async function request(target: string, referrer: string) {
  let promise!: Promise<Response>;
  handleFetch({
    request: { url: ENGINE + encodeDestLegacy(target), method: "GET", destination: "", mode: "cors", credentials: "same-origin", referrer, body: null, headers: new Headers() },
    clientId: "widget-page", resultingClientId: "",
    respondWith: (p: Promise<Response>) => { promise = p; }, waitUntil: () => {},
  } as unknown as FetchEvent);
  expect((await promise).status).toBe(200);
  expect(upstream.requests).toHaveLength(1);
  return upstream.requests[0];
}
describe("query-route virtual Referer (#435)", () => {
  it("does not send engine tokens upstream or change real query bytes", () => {
    const route = buildQueryHandleUrl(PAGE)!;
    expect(forwardedHeaders(new Request(ENGINE + "/api", { referrer: ENGINE + route }), PAGE, PAGE).get("referer")).toBe(PAGE);
  });
  it("preserves a page-authored zlNavh while removing only the verified token", () => {
    const page = "https://shop.example/mail?zlNavh=site-value&code=a%2Bb";
    const route = buildQueryHandleUrl(page)!;
    expect(forwardedHeaders(new Request(ENGINE + "/api", { referrer: ENGINE + route }), page, page).get("referer")).toBe(page);
  });
  it("honors no-referrer and forwards real path-route queries", () => {
    expect(forwardedHeaders(new Request(ENGINE + "/api", { referrer: "" }), PAGE, PAGE).has("referer")).toBe(false);
    const req = new Request(ENGINE + "/api", { referrer: ENGINE + encodeDestLegacy("https://shop.example/mail") + "?code=a%2Bb" });
    expect(forwardedHeaders(req, PAGE, PAGE).get("referer")).toBe("https://shop.example/mail?code=a%2Bb");
  });
});
describe("widget identity from browser-held context (#436)", () => {
  for (const referrer of ["", ENGINE + "/"]) {
    it("uses the actual non-provider page for reCAPTCHA with referrer " + JSON.stringify(referrer), async () => {
      establishContext(VCTX, "widget-page", PAGE);
      const sent = await request(recaptcha, referrer);
      expect(new URL(sent.url).searchParams.get("co")).toBe(co("https://shop.example:443"));
      if (!referrer) expect(sent.headers.has("referer")).toBe(false);
    });
    it("recovers hCaptcha context from a client route with referrer " + JSON.stringify(referrer), async () => {
      clientUrl = ENGINE + buildQueryHandleUrl(PAGE)!;
      const sent = await request(hcaptcha, referrer);
      expect(new URL(sent.url).searchParams.get("host")).toBe("shop.example");
      if (!referrer) expect(sent.headers.has("referer")).toBe(false);
    });
  }
  it("keeps unknown page identity unchanged instead of guessing the provider origin", () => {
    expect(virtualRecaptchaCo(recaptcha, "", ENGINE)).toBe(recaptcha);
    expect(virtualHcaptchaHost(hcaptcha, "", ENGINE)).toBe(hcaptcha);
    expect(virtualOgsOrigin(ogs, "", ENGINE)).toBe(ogs);
  });
  it("recovers the apps widget origin without adding an omitted Referer", async () => {
    establishContext(VCTX, "widget-page", PAGE);
    const sent = await request(ogs, "");
    expect(new URL(sent.url).searchParams.get("origin")).toBe("https://shop.example");
    expect(sent.headers.has("referer")).toBe(false);
  });
  it("keeps a correct site parameter despite another recovery context", () => {
    const target = recaptcha.replace(co(ENGINE + ":443"), co("https://correct.example:443"));
    expect(virtualRecaptchaCo(target, "", ENGINE, PAGE)).toBe(target);
  });
});
