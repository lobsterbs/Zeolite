import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySetCookie,
  cookieHeaderFor,
  cookiesResetForTests,
  documentCookieRead,
  documentCookieWrite,
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
