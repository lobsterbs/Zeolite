import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  documentCookieWrite,
  jarClearScope,
  jarEnumeration,
  jarLoad,
  jarPersist,
  jarReplace,
  jarSnapshot,
  registerOrigin,
  setJarProfile,
} from "../cookies";

/* Jar profiles (zl:jarProfile): the host app switches the whole jar
   between the durable default profile and a throwaway session profile
   (incognito isolation). Session cookies are in-memory only and die
   on switch-away or SW restart. */

beforeEach(() => cookiesResetForTests());
afterEach(() => cookiesResetForTests());

function resp(headers: string[]): Headers {
  const h = new Headers();
  for (const c of headers) h.append("set-cookie", c);
  return h;
}

describe("jar profiles (zl:jarProfile)", () => {
  it("a session profile isolates cookies from the default jar", () => {
    applySetCookie("https://a.example/", resp(["normal=1"]));
    expect(setJarProfile("inc-session")).toEqual({ ok: true, profile: "inc-session" });
    /* the default jar's cookie does not attach in the session */
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    applySetCookie("https://a.example/", resp(["inc=1"]));
    expect(cookieHeaderFor("https://a.example/")).toBe("inc=1");
    /* switching back drops the session jar entirely */
    expect(setJarProfile(null)).toEqual({ ok: true, profile: "default" });
    expect(cookieHeaderFor("https://a.example/")).toBe("normal=1");
  });

  it("session-profile cookies never persist to IndexedDB", async () => {
    setJarProfile("inc-keep-out");
    applySetCookie("https://a.example/", resp(["inc=2"]));
    await jarPersist();
    cookiesResetForTests();
    await jarLoad();
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
  });

  it("default-profile cookies persist while a session was active", async () => {
    applySetCookie("https://a.example/", resp(["keep=2"]));
    setJarProfile("inc-3");
    applySetCookie("https://a.example/", resp(["inc=3"]));
    await jarPersist();
    cookiesResetForTests();
    await jarLoad();
    /* only the default profile came back */
    expect(cookieHeaderFor("https://a.example/")).toBe("keep=2");
  });

  it("document.cookie reads and writes the active profile", () => {
    applySetCookie("https://a.example/", resp(["page=1"]));
    setJarProfile("inc-4");
    expect(documentCookieRead("https://a.example/")).toBe("");
    documentCookieWrite("https://a.example/", "incdoc=9");
    expect(documentCookieRead("https://a.example/")).toBe("incdoc=9");
    setJarProfile("default");
    expect(documentCookieRead("https://a.example/")).toBe("page=1");
  });

  it("jarSnapshot is the active profile keyed by bare origin id", () => {
    const aId = registerOrigin("https://a.example").id;
    applySetCookie("https://a.example/", resp(["normal=3"]));
    setJarProfile("inc-5");
    applySetCookie("https://a.example/", resp(["inc=5"]));
    const snap = jarSnapshot();
    expect(snap.size).toBe(1);
    expect(snap.has(aId)).toBe(true);
  });

  it("malformed profile input falls back to default honestly", () => {
    setJarProfile("inc-6");
    applySetCookie("https://a.example/", resp(["inc=6"]));
    const r = setJarProfile("");
    expect(r.profile).toBe("default");
    /* an empty-string switch away from a session profile drops it */
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    expect(setJarProfile(42 as never).profile).toBe("default");
  });

  it("session import replace stays inside the active profile", () => {
    const aId = registerOrigin("https://a.example").id;
    applySetCookie("https://a.example/", resp(["normal=4"]));
    setJarProfile("inc-7");
    jarReplace([
      [
        aId,
        [
          {
            name: "imp",
            value: "x",
            domain: "a.example",
            hostOnly: true,
            path: "/",
            secure: false,
            httpOnly: false,
            sameSite: null,
            expires: 0,
            created: Date.now(),
          },
        ],
      ],
    ]);
    expect(cookieHeaderFor("https://a.example/")).toBe("imp=x");
    setJarProfile("default");
    /* the default jar was not replaced by the session-profile import */
    expect(cookieHeaderFor("https://a.example/")).toBe("normal=4");
  });
});

/* #41 (zl:getJars / zl:clearJar): enumeration and scoped clear. */
describe("jar enumeration + scoped clear (#41)", () => {
  it("enumerates profiles with per-origin cookies and resolved origins", () => {
    applySetCookie("https://a.example/", resp(["a=1"]));
    setJarProfile("inc-enum");
    applySetCookie("https://b.example/", resp(["b=2"]));
    const views = jarEnumeration();
    expect(views).toHaveLength(2);
    const def = views.find((v) => v.profile === "default")!;
    expect(def.active).toBe(false);
    expect(def.cookies).toBe(1);
    expect(def.origins[0].origin).toBe("https://a.example");
    const inc = views.find((v) => v.profile === "inc-enum")!;
    expect(inc.active).toBe(true);
    expect(inc.origins[0].origin).toBe("https://b.example");
    expect(inc.origins[0].cookies[0]).toMatchObject({ name: "b", value: "2" });
  });

  it("reports the active profile even when it holds no cookies", () => {
    expect(jarEnumeration()).toEqual([
      { profile: "default", active: true, cookies: 0, origins: [] },
    ]);
  });

  it("survives a jar reload: ids map back to origins (#41)", async () => {
    applySetCookie("https://a.example/", resp(["keep=2"]));
    await jarPersist();
    cookiesResetForTests();
    await jarLoad();
    const views = jarEnumeration();
    expect(views[0].origins[0].origin).toBe("https://a.example");
  });

  it("clears one origin inside the active profile", () => {
    applySetCookie("https://a.example/", resp(["a=1"]));
    applySetCookie("https://b.example/", resp(["b=1"]));
    expect(jarClearScope(undefined, "https://a.example")).toMatchObject({
      ok: true,
      jars: 1,
      cookies: 1,
    });
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    expect(cookieHeaderFor("https://b.example/")).toBe("b=1");
  });

  it("clears a named session profile without touching the default jar", () => {
    applySetCookie("https://a.example/", resp(["keep=1"]));
    setJarProfile("inc-clear");
    applySetCookie("https://a.example/", resp(["inc=1"]));
    expect(jarClearScope("inc-clear", undefined)).toMatchObject({
      ok: true,
      jars: 1,
      cookies: 1,
    });
    expect(cookieHeaderFor("https://a.example/")).toBeNull();
    setJarProfile(null);
    expect(cookieHeaderFor("https://a.example/")).toBe("keep=1");
  });

  it("clears the active profile wholesale when no origin is given", () => {
    applySetCookie("https://a.example/", resp(["a=1"]));
    applySetCookie("https://b.example/", resp(["b=1"]));
    expect(jarClearScope(undefined, undefined)).toMatchObject({
      ok: true,
      jars: 2,
      cookies: 2,
    });
    expect(jarEnumeration()[0].cookies).toBe(0);
  });

  it("refuses malformed input instead of coercing", () => {
    applySetCookie("https://a.example/", resp(["keep=1"]));
    expect(jarClearScope("", undefined).ok).toBe(false);
    expect(jarClearScope(42, undefined).ok).toBe(false);
    expect(jarClearScope("bad\u0000sep", undefined).ok).toBe(false);
    expect(jarClearScope(undefined, "not an origin").ok).toBe(false);
    expect(cookieHeaderFor("https://a.example/")).toBe("keep=1");
  });
});
