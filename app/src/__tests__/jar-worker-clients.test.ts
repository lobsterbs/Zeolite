import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anySessionProfileActive,
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
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
});
