import { beforeEach, describe, expect, it } from "vitest";
import { parseURL, serializeURL } from "whatwg-url";
import { decodePath, encodeDestLegacy, mintableDest, setScheme } from "../codec";

/* codec keeps rotatable module state: reset the prefix like the other
   codec tests so a leaked scheme cannot skew the round-trips. */
beforeEach(() => setScheme("/j/"));

/* Corpus: absolute http(s) URLs that stress the WHATWG parser the
   engine depends on (native URL in parseUrl, mintableDest, codec). */
const CORPUS = [
  "https://example.com",
  "https://example.com/",
  "https://Example.COM:443/p%20ath?q=1#f",
  "https://example.com:8080/a/b?c=d#e",
  "http://example.com/#:~:text=foo",
  "https://xn--80ak6aa92e.com/",
  "https://käthe.example/straße?q=ä",
  "https://[2001:db8::1]:8443/x",
  "https://192.168.1.1:443/",
  "https://example.com./x",
  "https://user:pass@example.com/p",
  "https://example.com/a%2Fb?q=%20x",
  "https://example.com/a b",
  "https://example.com:65535/x",
  "http://localhost:3000/dev",
  "https://example.com/%C3%A4",
];

const NON_ROUTABLE = [
  "about:blank",
  "data:text/plain,hi",
  "blob:https://example.com/x",
  "ftp://example.com/",
  "javascript:alert(1)",
  "wss://example.com/",
  "file:///etc/passwd",
  "not a url at all",
];

describe("native URL vs the whatwg-url reference implementation", () => {
  for (const u of CORPUS) {
    it("parses and serializes " + JSON.stringify(u) + " identically", () => {
      const native = new URL(u);
      const rec = parseURL(u);
      expect(rec).not.toBeNull();
      expect(serializeURL(rec!)).toBe(native.href);
      /* mintability must follow the reference scheme, not a guess */
      const special = native.protocol === "http:" || native.protocol === "https:";
      expect(mintableDest(u)).toBe(special);
    });
  }

  it("mintableDest refuses everything non-http(s)", () => {
    for (const u of NON_ROUTABLE) expect(mintableDest(u)).toBe(false);
  });

  it("legacy routes round-trip every corpus URL byte-exactly", () => {
    for (const u of CORPUS) {
      const route = encodeDestLegacy(u);
      expect(route.startsWith("/j/")).toBe(true);
      expect(decodePath(route)).toBe(u);
    }
  });
});
