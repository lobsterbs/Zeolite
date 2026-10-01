import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { documentCookieWrite } from "../../cookies";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string, perms: string[], hosts: string[] = []): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: [...perms, ...hosts],
  };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

async function install(
  name: string,
  perms: string[],
  hosts: string[] = [],
): Promise<{ rec: ExtensionRecord; api: { browser: Record<string, unknown>; chrome: Record<string, unknown> } }> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, perms, hosts));
  const rec = extensions.get(id)!;
  const storage = {
    local: new ExtensionStorageArea(id, "local", "local"),
    sync: new ExtensionStorageArea(id, "sync", "sync"),
    session: new ExtensionStorageArea(id, "session", "session"),
  };
  return {
    rec,
    api: buildApi(
      rec,
      { extensionId: id, context: "background", url: null },
      { messenger: new ExtensionMessenger(), storage },
    ),
  };
}

describe("browser.cookies (#42)", () => {
  it("mounts only with the cookies permission", async () => {
    const { api } = await install("NoCookies", []);
    expect(api.browser.cookies).toBeUndefined();
  });

  it("gets jar cookies with host-permission and path semantics", async () => {
    const { api } = await install("CookieExt", ["cookies"], ["https://example.com/*"]);
    documentCookieWrite("https://example.com/", "zl_root=a1; Path=/");
    documentCookieWrite("https://example.com/deep", "zl_deep=a2; Path=/deep");
    const ck = api.browser.cookies as Record<string, unknown>;
    const got = await (ck.get as (d: Record<string, unknown>) => Promise<unknown>)({
      url: "https://example.com/deep/page",
      name: "zl_root",
    });
    expect(got).toMatchObject({
      name: "zl_root",
      value: "a1",
      domain: "example.com",
      hostOnly: true,
      path: "/",
      sessionId: true,
    });
    /* longest path wins at /deep */
    const deep = await (ck.get as (d: Record<string, unknown>) => Promise<unknown>)({
      url: "https://example.com/deep/x",
      name: "zl_deep",
    });
    expect(deep).toMatchObject({ name: "zl_deep", path: "/deep" });
    /* a path outside /deep never sees it */
    const miss = await (ck.get as (d: Record<string, unknown>) => Promise<unknown>)({
      url: "https://example.com/",
      name: "zl_deep",
    });
    expect(miss).toBeNull();
    /* unknown origin: honest rejection, not a silent empty view */
    await expect(
      (ck.get as (d: Record<string, unknown>) => Promise<unknown>)({
        url: "https://denied.example/",
        name: "zl_root",
      }),
    ).rejects.toThrow(/host permission/);
  });

  it("getAll filters by url or by permitted origins", async () => {
    /* Own origin: the jar is shared module state, and the earlier
       test already wrote cookies for example.com. */
    const { api } = await install("CookieAll", ["cookies"], ["https://all.example/*"]);
    documentCookieWrite("https://all.example/", "zl_all=a; Path=/");
    documentCookieWrite("https://all.example/", "zl_dom=b; Domain=all.example; Path=/");
    documentCookieWrite("https://other.example/", "zl_other=c; Path=/");
    const ck = api.browser.cookies as Record<string, unknown>;
    const all = await (ck.getAll as (d?: Record<string, unknown>) => Promise<unknown[]>)({
      url: "https://all.example/",
    });
    expect(all).toHaveLength(2);
    const byName = await (ck.getAll as (d?: Record<string, unknown>) => Promise<unknown[]>)({
      url: "https://all.example/",
      name: "zl_dom",
    });
    expect(byName).toHaveLength(1);
    expect(byName[0]).toMatchObject({ name: "zl_dom", hostOnly: false });
    /* no url: only origins the host permissions cover */
    const owned = await (ck.getAll as (d?: Record<string, unknown>) => Promise<unknown[]>)(undefined);
    const names = owned.map((c) => (c as { name: string }).name);
    expect(names).toContain("zl_all");
    expect(names).toContain("zl_dom");
    expect(names).not.toContain("zl_other");
  });

  it("sets through admission and reports rejected writes as null", async () => {
    const { api } = await install("CookieSet", ["cookies"], ["https://example.com/*"]);
    const ck = api.browser.cookies as Record<string, unknown>;
    const set = ck.set as (d: Record<string, unknown>) => Promise<unknown>;
    const made = await set({
      url: "https://example.com/",
      name: "zl_set",
      value: "v1",
      path: "/",
    });
    expect(made).toMatchObject({ name: "zl_set", value: "v1", hostOnly: true, path: "/" });
    /* httpOnly is stripped: a script context cannot mint it */
    const silent = await set({
      url: "https://example.com/",
      name: "zl_httponly",
      value: "v2",
      httpOnly: true,
    });
    expect(silent).toMatchObject({ name: "zl_httponly", httpOnly: false });
    /* a domain that does not scope the host is rejected -> null */
    const denied = await set({
      url: "https://example.com/",
      name: "zl_bad",
      value: "v3",
      domain: "unrelated.example",
    });
    expect(denied).toBeNull();
  });

  it("removes per identity and answers null when nothing matched", async () => {
    const { api } = await install("CookieRm", ["cookies"], ["https://example.com/*"]);
    documentCookieWrite("https://example.com/", "zl_rm=a; Path=/");
    documentCookieWrite("https://example.com/sub", "zl_rm=b; Path=/sub");
    const ck = api.browser.cookies as Record<string, unknown>;
    const rm = ck.remove as (d: Record<string, unknown>) => Promise<unknown>;
    const done = await rm({ url: "https://example.com/sub/x", name: "zl_rm" });
    expect(done).toEqual({ url: "https://example.com/sub/x", name: "zl_rm" });
    /* both path identities went away */
    const rest = await (ck.getAll as (d?: Record<string, unknown>) => Promise<unknown[]>)(undefined);
    expect(rest.filter((c) => (c as { name: string }).name === "zl_rm")).toHaveLength(0);
    expect(await rm({ url: "https://example.com/", name: "zl_rm" })).toBeNull();
  });
});
