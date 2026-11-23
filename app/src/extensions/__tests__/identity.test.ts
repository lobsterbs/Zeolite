import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { redirectUrlFor } from "../identity";

const enc = new TextEncoder();

/* #522: identity.getRedirectURL pins Firefox's own derivation
   (toolkit/components/extensions/child/ext-identity.js): sha1-hex of
   the extension id as the subdomain under the pref-governed redirect
   domain (extensions.allizom.org, the
   extensions.webextensions.identity.redirectDomain default), the
   path appended as a URL pathname. The literal vectors below were
   computed with node's own sha1, an independent oracle; the member is
   SYNC because Firefox's schema returns a plain string. */

const ID = "zeolite.parity@example";
const HASH = "f846dc68316f27ed3f13bdd3e29cc9f68e2a76a6";
const BASE = "https://" + HASH + ".extensions.allizom.org/";

function pkg(name: string, permissions: string[]): Map<string, Uint8Array> {
  return new Map([
    ["manifest.json", enc.encode(JSON.stringify({ manifest_version: 2, name, version: "1.0", permissions }))],
  ]);
}

async function apiFor(name: string, permissions: string[]) {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, permissions));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  const api = buildApi(
    rec,
    { extensionId: id, id, context: "background", url: null },
    { messenger: new ExtensionMessenger(), storage },
  );
  return { id, api };
}

describe("identity.getRedirectURL firefox derivation (#522)", () => {
  it("pins the derivation against node-computed literal vectors", () => {
    expect(redirectUrlFor(ID)).toBe(BASE);
    expect(redirectUrlFor(ID, "")).toBe(BASE);
    expect(redirectUrlFor(ID, "oauth2/callback")).toBe(BASE + "oauth2/callback");
    expect(redirectUrlFor(ID, "/a/b")).toBe(BASE + "a/b");
    /* Different id, different digest - the derivation is per-id. */
    expect(redirectUrlFor("other@example")).not.toContain(HASH);
  });

  it("mounts only with the identity permission and answers sync, derived from the record id", async () => {
    const bare = await apiFor("BareIdentity", []);
    expect((bare.api.browser as Record<string, unknown>).identity).toBeUndefined();
    const { id, api } = await apiFor("FullIdentity", ["identity"]);
    const ns = (api.browser as { identity: { getRedirectURL: (path?: string) => string } }).identity;
    expect(typeof ns.getRedirectURL).toBe("function");
    const url = ns.getRedirectURL("path/to");
    expect(typeof url).toBe("string");
    expect(url).toBe(BASE.replace(HASH, "") === BASE ? url : redirectUrlFor(id, "path/to"));
    expect(url).toBe(redirectUrlFor(id, "path/to"));
    expect(url.startsWith("https://")).toBe(true);
    expect(url.endsWith(".extensions.allizom.org/path/to")).toBe(true);
  });

  it("rejects non-string paths before the engine runs", async () => {
    const { api } = await apiFor("BadPathIdentity", ["identity"]);
    const ns = (api.browser as { identity: { getRedirectURL: (p?: unknown) => string } }).identity;
    expect(() => ns.getRedirectURL(42)).toThrow(TypeError);
    expect(() => ns.getRedirectURL(null)).toThrow(TypeError);
  });
});
