import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cookiesResetForTests,
  documentCookieWrite,
  jarClearScope,
  jarEnumeration,
  jarLoad,
  jarPersist,
  jarProfileState,
  registerOrigin,
  setJarProfile,
} from "../cookies";

beforeEach(() => cookiesResetForTests());

describe("jar enumeration (#41 zl:getJars)", () => {
  it("lists every profile with per-origin cookie records and active flags", () => {
    documentCookieWrite("https://a.example/", "a1=v; Path=/");
    documentCookieWrite("https://a.example/", "a2=w; Path=/");
    documentCookieWrite("https://b.example/", "b1=v; Path=/");
    setJarProfile("inc:t1");
    documentCookieWrite("https://c.example/", "c1=v; Path=/");

    const views = jarEnumeration();
    expect(views.map((v) => v.profile).sort()).toEqual(["default", "inc:t1"]);
    const def = views.find((v) => v.profile === "default")!;
    expect(def.active).toBe(false);
    expect(def.cookies).toBe(3);
    expect(def.origins.map((o) => o.origin).sort()).toEqual(["https://a.example", "https://b.example"]);
    expect(def.origins.every((o) => /^[a-z0-9]+$/.test(o.id))).toBe(true);
    const a = def.origins.find((o) => o.origin === "https://a.example")!;
    expect(a.cookies.map((c) => c.name).sort()).toEqual(["a1", "a2"]);

    const inc = views.find((v) => v.profile === "inc:t1")!;
    expect(inc.active).toBe(true);
    expect(inc.cookies).toBe(1);
    expect(inc.origins[0].origin).toBe("https://c.example");
  });

  it("always includes the active profile, even when it holds nothing", () => {
    const views = jarEnumeration();
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({ profile: "default", active: true, cookies: 0, origins: [] });
  });

  it("names origins after a restart via the persisted id map", async () => {
    documentCookieWrite("https://a.example/", "a1=v; Path=/");
    await jarPersist();
    await jarLoad();
    expect(jarProfileState()).toBe("default");
    const views = jarEnumeration();
    expect(views).toHaveLength(1);
    expect(views[0].origins[0].origin).toBe("https://a.example");
    expect(views[0].origins[0].cookies.map((c) => c.name)).toEqual(["a1"]);
  });
});

describe("jar clear (#41 zl:clearJar)", () => {
  it("clears only the active profile with honest counts", () => {
    documentCookieWrite("https://a.example/", "a1=v; Path=/");
    documentCookieWrite("https://a.example/", "a2=w; Path=/");
    documentCookieWrite("https://b.example/", "b1=v; Path=/");
    setJarProfile("inc:t1");
    documentCookieWrite("https://c.example/", "c1=v; Path=/");

    expect(jarClearScope()).toEqual({ ok: true, jars: 1, cookies: 1 });
    const def = jarEnumeration().find((v) => v.profile === "default")!;
    expect(def.cookies).toBe(3);
    expect(jarEnumeration().find((v) => v.profile === "inc:t1")!.cookies).toBe(0);
  });

  it("clears a named profile, or one origin inside it (URL or bare id)", () => {
    documentCookieWrite("https://a.example/", "a1=v; Path=/");
    documentCookieWrite("https://a.example/", "a2=w; Path=/");
    documentCookieWrite("https://b.example/", "b1=v; Path=/");

    expect(jarClearScope("default", "https://a.example/")).toEqual({ ok: true, jars: 1, cookies: 2 });
    let def = jarEnumeration()[0];
    expect(def.cookies).toBe(1);
    expect(def.origins[0].origin).toBe("https://b.example");

    const id = registerOrigin("https://b.example").id;
    expect(jarClearScope("default", id)).toEqual({ ok: true, jars: 1, cookies: 1 });
    def = jarEnumeration()[0];
    expect(def.cookies).toBe(0);
    expect(def.origins).toHaveLength(0);
  });

  it("refuses malformed input instead of coercing a destructive op", () => {
    documentCookieWrite("https://a.example/", "a1=v; Path=/");
    expect(jarClearScope("")).toEqual({ ok: false, error: "invalid profile", jars: 0, cookies: 0 });
    expect(jarClearScope("a\u0000b")).toEqual({ ok: false, error: "invalid profile", jars: 0, cookies: 0 });
    expect(jarClearScope(undefined, "!!!")).toEqual({ ok: false, error: "invalid origin", jars: 0, cookies: 0 });
    expect(jarClearScope(undefined, "UPPER")).toEqual({ ok: false, error: "invalid origin", jars: 0, cookies: 0 });
    /* nothing was cleared by the refused calls */
    expect(jarEnumeration()[0].cookies).toBe(1);
  });
});
