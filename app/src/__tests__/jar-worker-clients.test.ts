import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b64uEncode, encodeNavHandle, NAVH, setRouteKey } from "../codec";
import {
  anySessionProfileActive,
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  documentCookieWrite,
  inheritJarClient,
  jarClientHasRoot,
  jarEnumeration,
  jarProfileState,
  markJarClientUnbound,
  pruneJarClients,
  setJarProfile,
} from "../cookies";

/* #366: worker-originated subresources must ride their host window's
   jar profile, and a worker client that cannot be attributed must fail
   closed instead of reading or writing the shared default jar. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

describe("worker jar clients (#366)", () => {
  it("a worker client bound at script-fetch time rides the host profile", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    setJarProfile("inc-w", "hostW");
    applySetCookie("https://a.example/", resp(["w=1"]), "hostW");
    /* The worker script fetch arrives from the host client and seeds
       the binding for the resulting worker client (a keyed route, not
       a NAVH handle). */
    inheritJarClient("hostW", "workerW", "/j/worker-script-keyed-route");
    expect(jarClientHasRoot("workerW")).toBe(true);
    expect(jarProfileState("workerW")).toBe("inc-w");
    expect(cookieHeaderFor("https://a.example/", { clientId: "workerW" })).toBe("w=1");
    /* the default jar is untouched by the worker's session */
    expect(cookieHeaderFor("https://a.example/")).toBe("normal=1");
  });

  it("pruneJarClients keeps a lone worker client's binding and profile alive", () => {
    setJarProfile("inc-w", "hostW");
    inheritJarClient("hostW", "workerW", "/j/worker-script");
    /* only the worker client is live: the host window may be gone */
    pruneJarClients(new Set(["workerW"]));
    expect(jarClientHasRoot("workerW")).toBe(true);
    expect(jarProfileState("workerW")).toBe("inc-w");
  });

  it("an unattributable worker client stays cookie-free while a session profile is active", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    setJarProfile("inc-x", "clientX"); /* a session profile is active somewhere */
    expect(anySessionProfileActive()).toBe(true);
    markJarClientUnbound("workerU");
    /* no default-jar cookies out, no session cookies in */
    expect(cookieHeaderFor("https://a.example/", { clientId: "workerU" })).toBe(null);
    expect(applySetCookie("https://a.example/", resp(["leak=1"]), "workerU")).toEqual([]);
    expect(jarEnumeration().find((p) => p.profile === "default")?.cookies).toBe(1);
    /* the default jar itself is unaffected */
    expect(cookieHeaderFor("https://a.example/")).toBe("normal=1");
  });

  it("the shared unbound namespace admits nothing, so unbound clients cannot observe each other", () => {
    setJarProfile("inc", "clientX"); /* the unbound namespace exists only under profiles */
    markJarClientUnbound("u1");
    expect(applySetCookie("https://a.example/", resp(["x=1"]), "u1")).toEqual([]);
    markJarClientUnbound("u2");
    expect(cookieHeaderFor("https://a.example/", { clientId: "u2" })).toBe(null);
  });

  it("no session profile anywhere keeps default-jar cookies for plain clients", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    expect(anySessionProfileActive()).toBe(false);
    expect(cookieHeaderFor("https://a.example/", { clientId: "plainWorker" })).toBe("normal=1");
  });

  it("a default-deployment page client (bound root, never profiled) keeps cookie capture after a prune tick (#366 regression)", () => {
    setRouteKey(b64uEncode(crypto.getRandomValues(new Uint8Array(16))));
    const token = encodeNavHandle("https://a.example/", 60_000, "hostA");
    expect(token).toBeTruthy();
    inheritJarClient(undefined, "pageA", NAVH + "/" + token);
    setRouteKey(null);
    /* Pre-fix, this prune tick flipped the never-profiled live root
       unbound, which then dropped every upstream Set-Cookie. */
    pruneJarClients(new Set(["pageA"]));
    expect(jarProfileState("pageA")).toBe("default");
    expect(applySetCookie("https://a.example/", resp(["fx=1"]), "pageA")).toHaveLength(1);
    expect(cookieHeaderFor("https://a.example/", { clientId: "pageA" })).toBe("fx=1");
  });

  it("a session profile anywhere keeps a never-profiled bound root fail-closed", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    setRouteKey(b64uEncode(crypto.getRandomValues(new Uint8Array(16))));
    const token = encodeNavHandle("https://a.example/", 60_000, "hostA");
    inheritJarClient(undefined, "pageA", NAVH + "/" + token);
    setRouteKey(null);
    setJarProfile("inc", "clientX");
    pruneJarClients(new Set(["pageA", "clientX"]));
    expect(cookieHeaderFor("https://a.example/", { clientId: "pageA" })).toBe(null);
    expect(applySetCookie("https://a.example/", resp(["x=1"]), "pageA")).toEqual([]);
    /* fail-closed, not fail-wrong: the default jar is untouched */
    expect(cookieHeaderFor("https://a.example/")).toBe("normal=1");
  });

  it("the shared unbound namespace admits nothing on the document.cookie seam either", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    setJarProfile("inc", "clientX");
    markJarClientUnbound("u1");
    expect(documentCookieWrite("https://a.example/", "leak=1", "u1").stored).toBe(false);
    expect(documentCookieRead("https://a.example/", "u1")).toBe("");
    /* nothing seeded for a second unbound client to observe */
    markJarClientUnbound("u2");
    expect(documentCookieRead("https://a.example/", "u2")).toBe("");
  });
});
