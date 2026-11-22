import { beforeEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  buildQueryHandleUrl,
  decodeQueryHandle,
  NAVH_TTL_MS,
  queryHandleToken,
  setRouteKey,
  setScheme,
} from "../codec";
import { navpResolve } from "../request";
import { NAVP } from "../bootstrap/navguard";

/* #708 (the bscframe ghost class): a query-shape committed page
   (real path + zlNavh in the search) can carry a #101 prel tail on
   its committed path - <real path>/__zl_prel__/<enc(input)> - minted
   by the navguard token arm. The raw pathname compose used to ship
   the tail upstream verbatim: the SW decoded the committed query
   route and composed destination = origin + RAW pathname, so
   /_/bscframe/__zl_prel__/%2Fguest-host.html reached the host in one
   piece and 404ed. The decode now peels the tail (bounded, the
   decodeNavHandlePath contract) and resolves the peeled input against
   the peeled parent: root-relative inputs anchor at the token-named
   origin, relative inputs keep document (base) semantics. Fail-closed
   everywhere: undecodable tails, absolute impostor tails and stacks
   deeper than four decode to null. */

const ENGINE = "https://engine.host";
const SITE = "https://accounts.google.com";
const KEY = b64uEncode(new Uint8Array(16).map((_, i) => i + 1));

const enc = encodeURIComponent;

/* The committed parent form: the engine's own mint, token included.
   Returns the query-route URL string plus its raw token. */
function committed(dest: string, root?: string): { url: string; tok: string } {
  const url = buildQueryHandleUrl(dest, NAVH_TTL_MS, root);
  if (url === null) throw new Error("mint failed (no route key)");
  const tok = queryHandleToken(new URL(url, ENGINE).search);
  if (tok === null) throw new Error("minted URL carries no zlNavh");
  return { url, tok };
}

describe("decodeQueryHandle prel peel (#708 ghost)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(KEY);
  });

  it("peels a root-relative prel tail (the captured ghost shape)", () => {
    const { tok } = committed(SITE + "/_/bscframe");
    const u = new URL(
      ENGINE + "/_/bscframe" + NAVP + "/" + enc("/guest-host.html") + "?zlNavh=" + tok,
    );
    /* upstream used to receive the ghost in one piece and 404 it */
    const d = decodeQueryHandle(u);
    expect(d?.destination).toBe(SITE + "/guest-host.html");
  });

  it("peels a deeper-path parent (the /v3/signin class)", () => {
    const { tok } = committed(SITE + "/v3/signin/identifier");
    const u = new URL(
      ENGINE + "/v3/signin/identifier" + NAVP + "/" + enc("/x/y?hl=en") + "?zlNavh=" + tok,
    );
    expect(decodeQueryHandle(u)?.destination).toBe(SITE + "/x/y?hl=en");
  });

  it("keeps document (base) semantics for a relative tail", () => {
    const { tok } = committed(SITE + "/_/bscframe");
    const u = new URL(
      ENGINE + "/_/bscframe" + NAVP + "/" + enc("guest-host.html") + "?zlNavh=" + tok,
    );
    /* the prel input was relative: it resolves against the parent
       path's directory, exactly like the decodePrel seam */
    expect(decodeQueryHandle(u)?.destination).toBe(SITE + "/_/bscframe/guest-host.html");
  });

  it("keeps the rootClientId lineage across the peel", () => {
    const { tok } = committed(SITE + "/_/bscframe", "root-client-1");
    const u = new URL(
      ENGINE + "/_/bscframe" + NAVP + "/" + enc("/guest-host.html") + "?zlNavh=" + tok,
    );
    expect(decodeQueryHandle(u)?.rootClientId).toBe("root-client-1");
  });

  it("peels a stacked tail (bounded) and refuses one deeper than four", () => {
    const { tok } = committed(SITE + "/_/bscframe");
    const inner = "/y";
    const stack2 = "/a" + NAVP + "/" + enc("/b" + NAVP + "/" + enc(inner));
    const u2 = new URL(ENGINE + "/_/bscframe" + NAVP + "/" + enc(stack2) + "?zlNavh=" + tok);
    expect(decodeQueryHandle(u2)?.destination).toBe(SITE + "/y");
    /* six hops: too deep, the honest null */
    let stack6 = inner;
    for (let i = 0; i < 6; i++) stack6 = "/p" + NAVP + "/" + enc(stack6);
    const u6 = new URL(ENGINE + "/_/bscframe" + NAVP + "/" + enc(stack6) + "?zlNavh=" + tok);
    expect(decodeQueryHandle(u6)).toBeNull();
  });

  it("fails closed on an undecodable or absolute-impostor tail", () => {
    const { tok } = committed(SITE + "/_/bscframe");
    const bad = new URL(ENGINE + "/_/bscframe" + NAVP + "/%zz?zlNavh=" + tok);
    expect(decodeQueryHandle(bad)).toBeNull();
    const spy = new URL(
      ENGINE + "/_/bscframe" + NAVP + "/" + enc("https://evil.example/x") + "?zlNavh=" + tok,
    );
    expect(decodeQueryHandle(spy)).toBeNull();
  });

  it("leaves the plain committed route byte-identical (no tail, no change)", () => {
    const { url, tok } = committed(SITE + "/_/bscframe");
    const u = new URL(ENGINE + url);
    expect(decodeQueryHandle(u)?.destination).toBe(SITE + "/_/bscframe");
    /* the token never rides the destination */
    expect(decodeQueryHandle(u)?.destination.includes(tok)).toBe(false);
  });
});

describe("navpResolve parent search (#708 parent decode)", () => {
  beforeEach(() => {
    setScheme("/j/");
    setRouteKey(KEY);
  });

  it("decodes a query-shape parent through the request's own search", () => {
    const { tok } = committed(SITE + "/_/bscframe");
    const d = navpResolve(
      "/_/bscframe" + NAVP + "/" + enc("/guest-host.html"),
      undefined,
      undefined,
      undefined,
      "?zlNavh=" + tok,
    );
    expect(d).toBe(SITE + "/guest-host.html");
  });

  it("stays null without the parent search (no invented fallback)", () => {
    const { tok } = committed(SITE + "/_/bscframe");
    void tok;
    expect(
      navpResolve("/_/bscframe" + NAVP + "/" + enc("/guest-host.html")),
    ).toBeNull();
  });
});
