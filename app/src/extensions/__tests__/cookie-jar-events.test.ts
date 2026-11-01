import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach } from "vitest";
import { extensions } from "../manager";
import { cookiesGet, cookiesSet, onCookieChanged, cookiesRemove } from "../cookies";
import { applySetCookie, documentCookieWrite, jarClear, cookiesResetForTests } from "../../cookies";
import type { JarCookieChange } from "../../cookies";
import type { CookieChange } from "../cookies";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

async function install(name: string, hosts: string[]): Promise<ExtensionRecord> {
  await extensions.startup();
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: ["cookies"],
    host_permissions: hosts,
  };
  const { id } = await extensions.installFiles(
    new Map([["manifest.json", enc.encode(JSON.stringify(manifest))]]),
  );
  return extensions.get(id)!;
}

/* Each test gets a clean jar; names give unique ids. */
beforeEach(() => {
  jarClear();
  cookiesResetForTests();
});

describe("cookies.onChanged jar seam (#520)", () => {
  it("surfaces upstream Set-Cookie captures: explicit for new, overwrite for replaced", async () => {
    const rec = await install("JarExt", ["https://*.example.com/*"]);
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    const headers = new Headers([["set-cookie", "sid=abc; Path=/; Domain=example.com"]]);
    const results = applySetCookie("https://www.example.com/", headers);
    expect(results[0]?.stored).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cause: "explicit",
      removed: false,
      cookie: { name: "sid", value: "abc", domain: "example.com" },
    });
    // the same identity again: overwrite
    const headers2 = new Headers([["set-cookie", "sid=def; Path=/; Domain=example.com"]]);
    applySetCookie("https://www.example.com/", headers2);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      cause: "overwrite",
      removed: false,
      cookie: { name: "sid", value: "def" },
    });
    // the jar read agrees with the last event
    const got = await cookiesGet(rec, { url: "https://www.example.com/", name: "sid" });
    expect(got?.value).toBe("def");
  });

  it("reports server-issued deletions as expired_overwrite with the old view", async () => {
    const rec = await install("JarDel", ["https://*.example.com/*"]);
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    applySetCookie(
      "https://www.example.com/",
      new Headers([["set-cookie", "old=1; Path=/; Domain=example.com"]]),
    );
    expect(events).toHaveLength(1);
    applySetCookie(
      "https://www.example.com/",
      new Headers([["set-cookie", "old=; Path=/; Domain=example.com; Max-Age=0"]]),
    );
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      cause: "expired_overwrite",
      removed: true,
      cookie: { name: "old", value: "1" },
    });
  });

  it("fires exactly once for an extension cookies.set (no double event)", async () => {
    const rec = await install("JarSet", ["https://*.example.com/*"]);
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    const view = await cookiesSet(rec, {
      url: "https://www.example.com/",
      name: "ext",
      value: "v1",
    });
    expect(view?.value).toBe("v1");
    expect(events).toHaveLength(1);
    expect(events[0].cause).toBe("explicit");
    await cookiesSet(rec, { url: "https://www.example.com/", name: "ext", value: "v2" });
    expect(events).toHaveLength(2);
    expect(events[1].cause).toBe("overwrite");
  });

  it("surfaces page document.cookie writes to the extension", async () => {
    const rec = await install("JarPage", ["https://*.example.com/*"]);
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    const r = documentCookieWrite("https://www.example.com/", "page=1; Path=/");
    expect(r.stored).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cause: "explicit", cookie: { name: "page", value: "1" } });
  });

  it("never surfaces session-profile admissions or rejected Set-Cookie", async () => {
    const rec = await install("JarGate", ["https://*.example.com/*"]);
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    // rejected admission (samesite none without secure)
    const results = applySetCookie(
      "https://www.example.com/",
      new Headers([["set-cookie", "bad=1; SameSite=None; Path=/"]]),
    );
    expect(results[0]?.rejected).toBeTruthy();
    expect(events).toHaveLength(0);
    // a deletion Set-Cookie for an identity that never existed: no event
    applySetCookie(
      "https://www.example.com/",
      new Headers([["set-cookie", "ghost=; Max-Age=0; Path=/"]]),
    );
    expect(events).toHaveLength(0);
    // a session-profile admission never reaches extension listeners:
    // the seam sees it (with its namespace), the bridge filters it
    const { onCookieJarChange, setJarProfile } = await import("../../cookies");
    setJarProfile("session", "rootA");
    const probe: JarCookieChange[] = [];
    const off = onCookieJarChange((c) => probe.push(c));
    applySetCookie(
      "https://www.example.com/",
      new Headers([["set-cookie", "sess=1; Path=/"]]),
      "rootA",
    );
    expect(probe.filter((c) => c.result.name === "sess")).toHaveLength(1);
    expect(probe[probe.length - 1].result.namespace).not.toBe("default");
    expect(events).toHaveLength(0);
    off();
  });

  it("keeps host-permission gating: no grant for the domain, no event", async () => {
    const rec = await install("JarNoHost", ["https://*.other.example/*"]);
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    applySetCookie(
      "https://www.example.com/",
      new Headers([["set-cookie", "sid=abc; Path=/; Domain=example.com"]]),
    );
    expect(events).toHaveLength(0);
  });

  it("extension cookies.remove still reports explicit removals", async () => {
    const rec = await install("JarRm", ["https://*.example.com/*"]);
    await cookiesSet(rec, { url: "https://www.example.com/", name: "gone", value: "1" });
    const events: CookieChange[] = [];
    onCookieChanged(rec, (c) => events.push(c));
    const r = await cookiesRemove(rec, { url: "https://www.example.com/", name: "gone" });
    expect(r).toEqual({ url: "https://www.example.com/", name: "gone" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cause: "explicit", removed: true, cookie: { name: "gone" } });
  });
});
