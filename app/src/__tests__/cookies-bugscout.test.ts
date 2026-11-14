import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  jarSnapshot,
} from "../cookies";

/* Bug-scout pins for the cookie jar (the TS mirror of the Rust
   bugscout.rs rows). The TS layer shared two of the four Rust
   defects: the case-sensitive prefix gate (the loopback over-match
   was a Rust-port-only slip and the TS sweep already applied the
   per-domain pass before the total pass). */

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

describe("cookie jar bug-scout (#614)", () => {
  it("enforces the 6265bis name prefixes case-insensitively", () => {
    const r1 = applySetCookie("https://a.example/", resp(["__secure-k=1"]));
    expect(r1[0].stored).toBe(false);
    expect(r1[0].rejected).toBe("prefix requires secure");
    /* A case-variant spelling that satisfies every invariant stores. */
    const r2 = applySetCookie("https://a.example/", resp(["__HOST-k=1; Secure"]));
    expect(r2[0].stored).toBe(true);
    /* The host-only invariant applies to any case spelling: a Domain
       attribute defeats it. */
    const r3 = applySetCookie("https://a.example/", resp(["__host-k=1; Secure; Domain=a.example"]));
    expect(r3[0].stored).toBe(false);
    expect(r3[0].rejected).toBe("__Host- requires host-only and path /");
    expect(cookieHeaderFor("https://a.example/")).toBe("__HOST-k=1");
    expect(jarSnapshot().size).toBe(1);
  });

  it("ignores attribute values carrying control characters", () => {
    /* A control character inside the Path value is outside the 5.2
       grammar: the attribute is ignored, the cookie keeps the
       default path. (Headers admits U+001D but not CR/LF, so the
       poisoned attribute reaches the parser this way.) */
    const r = applySetCookie("https://a.example/x/y", resp(["k=1; Path=/evil\u001dpath"]));
    expect(r[0].stored).toBe(true);
    /* The cookie answers on the default path (the request URI's
       directory), never on the poisoned attribute. */
    expect(cookieHeaderFor("https://a.example/x/other")).toBe("k=1");
  });
});
