import { beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, encodeDest, setRouteKey, setScheme } from "../codec";
import { virtualPersonaIframeOrigin } from "../request";

/* The Persona KYC widget seam (#605, the #112 co= class): the KYC
   Links integration builds bridge.withpersona.com/widget with an
   iframe-origin= parameter from window.location.origin
   (LegacyUnforgeable), so a virtualized page names the engine origin
   and Persona's per-template Domain Manager allowlist refuses the
   embed (X-Frame-Options deny). */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const PAGE = "https://www.example.com/verify";

const widget = (origin: string) =>
  "https://bridge.withpersona.com/widget?environment=production&inquiry-template-id=tmpl_123" +
  "&fields%5Biqt_token%5D=tok_123&iframe-origin=" +
  encodeURIComponent(origin);

const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i));

describe("virtualPersonaIframeOrigin (#605 persona class)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(null);
  });

  it("rewrites an iframe-origin= naming the engine origin to the page origin", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    expect(virtualPersonaIframeOrigin(widget(ENGINE), ref, ENGINE))
      .toBe(widget("https://www.example.com"));
  });

  it("rewrites port-suffixed engine forms and leaves every other param untouched", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const out = virtualPersonaIframeOrigin(widget(ENGINE + ":443"), ref, ENGINE);
    expect(out).toBe(widget("https://www.example.com"));
    expect(out).toContain("environment=production");
    expect(out).toContain("inquiry-template-id=tmpl_123");
    expect(out).toContain("fields%5Biqt_token%5D=tok_123");
  });

  it("leaves an iframe-origin= naming a real domain alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const inUrl = widget("https://www.example.com");
    expect(virtualPersonaIframeOrigin(inUrl, ref, ENGINE)).toBe(inUrl);
  });

  it("leaves non-persona hosts and non-widget paths alone", () => {
    setRouteKey(KEY);
    const ref = ENGINE + encodeDest(PAGE);
    const otherHost = "https://withpersona.com/widget?iframe-origin=" + encodeURIComponent(ENGINE);
    expect(virtualPersonaIframeOrigin(otherHost, ref, ENGINE)).toBe(otherHost);
    const deep = "https://bridge.withpersona.com/widget/extra?iframe-origin=" + encodeURIComponent(ENGINE);
    expect(virtualPersonaIframeOrigin(deep, ref, ENGINE)).toBe(deep);
    const inquiry = "https://withpersona.com/inquiry/abc?iframe-origin=" + encodeURIComponent(ENGINE);
    expect(virtualPersonaIframeOrigin(inquiry, ref, ENGINE)).toBe(inquiry);
  });

  it("fails closed without a usable referrer or initiator", () => {
    setRouteKey(KEY);
    const inUrl = widget(ENGINE);
    expect(virtualPersonaIframeOrigin(inUrl, "", ENGINE)).toBe(inUrl);
  });
});
