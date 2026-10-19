import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  documentCookieWrite,
  flushJarPersist,
  jarClearScope,
  jarEnumeration,
  jarLoad,
  setJarProfile,
} from "../cookies";

/* #267: jar profiles scoped to the requesting host client (one host
   window normal, another incognito), plus the #254 durable flush. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

describe("per-client jar profiles (#267)", () => {
  it("two clients keep independent profiles", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    expect(setJarProfile("inc-a", "clientA")).toEqual({ ok: true, profile: "inc-a" });
    applySetCookie("https://a.example/", resp(["a=1"]), "clientA");
    expect(cookieHeaderFor("https://a.example/", { clientId: "clientA" })).toBe("a=1");
    /* the default jar is untouched by clientA's session */
    expect(cookieHeaderFor("https://a.example/")).toBe("normal=1");
    /* clientB (no profile of its own) falls back to the global */
    expect(cookieHeaderFor("https://a.example/", { clientId: "clientB" })).toBe("normal=1");
  });

  it("document.cookie reads and writes scope to the client profile", () => {
    setJarProfile("inc-b", "clientB");
    expect(documentCookieWrite("https://b.example/", "b=2", "clientB")).toMatchObject({ name: "b", stored: true });
    expect(documentCookieRead("https://b.example/", "clientB")).toBe("b=2");
    /* the global view never sees clientB's session cookie */
    expect(documentCookieRead("https://b.example/")).toBe("");
  });

  it("switching one client back drops only that client's session jars", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    setJarProfile("inc-a", "clientA");
    setJarProfile("inc-c", "clientC");
    applySetCookie("https://a.example/", resp(["a=1"]), "clientA");
    applySetCookie("https://a.example/", resp(["c=1"]), "clientC");
    expect(setJarProfile(null, "clientA")).toEqual({ ok: true, profile: "default" });
    /* clientA sees the default jar again, its session is gone */
    expect(cookieHeaderFor("https://a.example/", { clientId: "clientA" })).toBe("normal=1");
    /* clientC keeps its own session */
    expect(cookieHeaderFor("https://a.example/", { clientId: "clientC" })).toBe("c=1");
  });

  it("unknown clients fall back to the global profile", () => {
    setJarProfile("inc-global");
    applySetCookie("https://g.example/", resp(["g=1"]));
    expect(cookieHeaderFor("https://g.example/", { clientId: "nobody" })).toBe("g=1");
  });

  it("jarEnumeration marks the requester's profile active", () => {
    setJarProfile("inc-d", "clientD");
    const globalView = jarEnumeration();
    expect(globalView.find((p) => p.profile === "default")?.active).toBe(true);
    const clientView = jarEnumeration("clientD");
    expect(clientView.find((p) => p.profile === "inc-d")?.active).toBe(true);
    /* empty profiles other than the requester's active one are not listed */
    expect(clientView.find((p) => p.profile === "default")).toBeUndefined();
  });

  it("jarClearScope clears the requester's active profile when unnamed", () => {
    setJarProfile("inc-e", "clientE");
    applySetCookie("https://e.example/", resp(["e=1"]), "clientE");
    const r = jarClearScope(undefined, undefined, "clientE");
    expect(r).toMatchObject({ ok: true, jars: 1, cookies: 1 });
    expect(documentCookieRead("https://e.example/", "clientE")).toBe("");
  });
});

describe("resilient jar persistence (#254)", () => {
  it("flushJarPersist writes the jar durably without the debounce", async () => {
    applySetCookie("https://p.example/", resp(["p=1"]));
    await flushJarPersist();
    cookiesResetForTests();
    await jarLoad();
    expect(cookieHeaderFor("https://p.example/")).toBe("p=1");
  });

  it("flushJarPersist keeps a second write from racing the first", async () => {
    applySetCookie("https://q.example/", resp(["q=1"]));
    const first = flushJarPersist();
    applySetCookie("https://q.example/", resp(["q=2"]));
    await first;
    await flushJarPersist();
    cookiesResetForTests();
    await jarLoad();
    /* the newest admission wins: the serialized chain snapshots the
       live jars at each write's own turn, never a stale one. */
    expect(cookieHeaderFor("https://q.example/")).toBe("q=2");
  });
});
