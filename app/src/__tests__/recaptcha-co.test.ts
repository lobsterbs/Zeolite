import { describe, expect, it } from "vitest";
import { virtualRecaptchaCo } from "../request";

/* #112: the recaptcha co= seam. Pure logic only - the referrer decode
   needs live route keys, so these exercise the no-referrer fallback and
   the leave-alone gates. */
const ENGINE = "https://lobsterbrowse-beta.onrender.com";
const b64 = (s: string) => btoa(s).replace(/=+$/, (p) => ".".repeat(p.length));
const anchor = (co: string) =>
  "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=KEY&co=" + co + "&hl=en&v=V";

describe("virtualRecaptchaCo (#112)", () => {
  it("rewrites a co= that names the engine origin to the page origin", () => {
    expect(virtualRecaptchaCo(anchor(b64(ENGINE + ":443")), "", ENGINE))
      .toBe(anchor(b64("https://www.google.com:443")));
  });

  it("rewrites the bare engine origin form too", () => {
    expect(virtualRecaptchaCo(anchor(b64(ENGINE)), "", ENGINE))
      .toBe(anchor(b64("https://www.google.com:443")));
  });

  it("leaves a co= naming another origin alone", () => {
    const inUrl = anchor(b64("https://example.com:443"));
    expect(virtualRecaptchaCo(inUrl, "", ENGINE)).toBe(inUrl);
  });

  it("leaves non-recaptcha hosts, paths and co-less queries alone", () => {
    expect(virtualRecaptchaCo("https://www.google.com/search?q=hi&co=x", "", ENGINE))
      .toBe("https://www.google.com/search?q=hi&co=x");
    expect(virtualRecaptchaCo("https://example.com/recaptcha/enterprise/anchor?ar=1", "", ENGINE))
      .toBe("https://example.com/recaptcha/enterprise/anchor?ar=1");
  });
});
