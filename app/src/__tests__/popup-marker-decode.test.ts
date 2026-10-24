import { afterEach, describe, expect, it } from "vitest";
import { b64uEncode, buildQueryHandleUrl, decodeClientUrl, setRouteKey, setScheme } from "../codec";
import { navEncode } from "../bootstrap/navguard";
const ENGINE = "https://engine.example";
afterEach(() => { setRouteKey(null); setScheme("/j/"); });
describe("popup marker oracle parity (#428)", () => {
  it("decodes Google/Gmail-style sign-in markers regardless of configured prefix", () => {
    const dest = "https://accounts.google.com/AccountChooser/signinchooser?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&flowName=GlifWebSignIn&ec=asw-gmail-globalnav-signin";
    setScheme("/zl/");
    expect(decodeClientUrl(new URL(navEncode(dest), ENGINE))).toBe(dest);
  });
  it("refuses malformed marker tokens, invalid UTF-8 and non-HTTP destinations", () => {
    for (const path of ["/__zl_nav__/Y", "/__zl_nav__/%%%", "/__zl_nav__/YWJjY", navEncode("javascript:alert(1)"), "/__zl_nav__/" + b64uEncode(new Uint8Array([0xff]))]) {
      expect(decodeClientUrl(new URL(path, ENGINE))).toBeNull();
    }
  });
  it("gives the route-shaped marker precedence over an impostor query handle", () => {
    setRouteKey(new Uint8Array(32).fill(7));
    const q = buildQueryHandleUrl("https://unrelated.example/page")!;
    const tok = new URL(q, ENGINE).searchParams.get("zlNavh")!;
    const dest = "https://accounts.example/signin";
    // Native marker search remains target-owned, never a different handle's origin.
    expect(decodeClientUrl(new URL(navEncode(dest) + "?zlNavh=" + tok, ENGINE))).toBe(dest + "?zlNavh=" + tok);
  });
});
