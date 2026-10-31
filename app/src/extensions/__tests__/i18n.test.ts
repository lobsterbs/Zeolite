import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { serveExtensionAsset, EXT_ROUTE } from "../serve";
import { PAGE_BRIDGE_SOURCE } from "../pagebridge";
import { messagesFromJson, resolvePackageI18n, i18nGetMessage, makeI18nNs } from "../i18n";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string, files: Record<string, string> = {}): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: [], default_locale: "en" };
  const m = new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
  for (const [k, v] of Object.entries(files)) m.set(k, enc.encode(v));
  return m;
}

/* Install ids derive from manifest bytes, so every install needs a
   unique manifest name. */
let seq = 0;

async function install(name: string, files: Record<string, string> = {}): Promise<ExtensionRecord> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name + " #" + seq++, files));
  return extensions.get(id)!;
}

const LOCALES = {
  hello: { message: "Hello $USER$ ($1)", placeholders: { USER: { content: "world" } } },
  bye: { message: "Bye" },
  NUM: { message: "n=$2 then $1" },
};

describe("chrome.i18n (#560)", () => {
  it("folds message names case-insensitively and keeps placeholders", () => {
    const m = messagesFromJson({ HELLO: LOCALES.hello, bye: LOCALES.bye, bad: 5 });
    expect(Object.keys(m).sort()).toEqual(["bye", "hello"]);
    expect(m.hello.message).toBe("Hello $USER$ ($1)");
    expect(m.hello.placeholders.user).toBe("world");
  });

  it("resolves the package _locales with navigator-first candidates", async () => {
    const rec = await install("I18nRes", { "_locales/en/messages.json": JSON.stringify(LOCALES) });
    const res = await resolvePackageI18n("en", (p) => extensions.getResource(rec.id, p, { fromWeb: false }));
    expect(res.locale).toBe("en");
    expect(i18nGetMessage(res, "HELLO", ["x"])).toBe("Hello world (x)");
    expect(i18nGetMessage(res, "bye")).toBe("Bye");
    expect(i18nGetMessage(res, "missing")).toBe("");
    expect(i18nGetMessage(res, 5)).toBe("");
    expect(i18nGetMessage(res, "NUM", ["a", "b"])).toBe("n=b then a");
  });

  it("falls back to an empty map when no messages.json exists", async () => {
    const rec = await install("I18nEmpty");
    const res = await resolvePackageI18n("", (p) => extensions.getResource(rec.id, p, { fromWeb: false }));
    expect(res.messages).toEqual({});
    expect(i18nGetMessage(res, "hello")).toBe("");
  });

  it("reports the resolved locale from makeI18nNs", async () => {
    const ns = makeI18nNs({ locale: "en", messages: {} });
    expect(ns.getUILanguage()).toBe("en");
    const langs = await ns.getAcceptLanguages();
    expect(Array.isArray(langs)).toBe(true);
    expect(ns.getMessage("nope")).toBe("");
  });

  it("mounts i18n on browser and chrome even without deps.i18n", async () => {
    const rec = await install("I18nApi");
    const storage = {
      local: new ExtensionStorageArea(rec.id, "local", "local"),
      sync: new ExtensionStorageArea(rec.id, "sync", "sync"),
      session: new ExtensionStorageArea(rec.id, "session", "session"),
    };
    const api = buildApi(rec, { extensionId: rec.id, context: "background", url: null }, {
      messenger: new ExtensionMessenger(),
      storage,
    });
    const bi = api.browser.i18n as Record<string, unknown>;
    const ci = api.chrome.i18n as Record<string, unknown>;
    expect(typeof bi.getMessage).toBe("function");
    expect((bi.getMessage as (n: unknown) => string)("nope")).toBe("");
    expect(typeof ci.getMessage).toBe("function");
    expect(typeof ci.getUILanguage).toBe("function");
  });

  it("embeds the resolved locales in the pagejs bridge", async () => {
    const rec = await install("I18nPage", { "_locales/en/messages.json": JSON.stringify(LOCALES) });
    const url = "https://sw.example" + EXT_ROUTE + rec.id + "/__page.js";
    const res = await serveExtensionAsset(new Request(url), new URL(url));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"i18n"');
    expect(body).toContain("Hello $USER$ ($1)");
    /* The page-world side of the contract: sync getMessage plus the
       two locale getters, all materialized from ZL_PAGE_CFG. */
    expect(PAGE_BRIDGE_SOURCE).toContain("getMessage");
    expect(PAGE_BRIDGE_SOURCE).toContain("getUILanguage");
    expect(PAGE_BRIDGE_SOURCE).toContain("getAcceptLanguages");
  });
});
