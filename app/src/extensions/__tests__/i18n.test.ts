import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { serveExtensionAsset, EXT_ROUTE, CS_ROUTE } from "../serve";
import { PAGE_BRIDGE_SOURCE } from "../pagebridge";
import {
  messagesFromJson,
  resolvePackageI18n,
  i18nGetMessage,
  makeI18nNs,
  substituteCss,
  substituteManifestStrings,
} from "../i18n";
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

  it("falls back per key to the default_locale catalog when the UI catalog misses the key (#523)", async () => {
    /* Tampermonkey 5.5.0's exact shape: the nb catalog ships without
       v0version0, which the en default_locale defines with a $1
       placeholder (its options header rendered the raw key). */
    const en = {
      extName: { message: "Extension" },
      v0version0: { message: "v$version$", placeholders: { version: { content: "$1" } } },
    };
    const nb = { extName: { message: "Utvidelse" } };
    const read = (p: string): Promise<Uint8Array | null> => {
      if (p === "_locales/nb/messages.json") return Promise.resolve(enc.encode(JSON.stringify(nb)));
      if (p === "_locales/en/messages.json") return Promise.resolve(enc.encode(JSON.stringify(en)));
      return Promise.resolve(null);
    };
    vi.stubGlobal("navigator", { language: "nb-NO" });
    try {
      const res = await resolvePackageI18n("en", read);
      expect(res.locale).toBe("nb");
      expect(i18nGetMessage(res, "extName")).toBe("Utvidelse");
      expect(i18nGetMessage(res, "v0version0", ["5.5.0"])).toBe("v5.5.0");
      expect(i18nGetMessage(res, "missingFromBoth")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
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

describe("CSS __MSG_ substitution (#523)", () => {
  it("substitutes message tokens case-folded and keeps unresolved literals", () => {
    const res = { locale: "en", messages: messagesFromJson({ greeting: { message: "hi" }, EDGE: { message: "left-edge" } }) };
    expect(substituteCss("a{content:'__MSG_greeting__'}", res)).toBe("a{content:'hi'}");
    expect(substituteCss("a{__MSG_EDGE__:0}", res)).toBe("a{left-edge:0}");
    expect(substituteCss("a{content:'__MSG_missing__'}", res)).toBe("a{content:'__MSG_missing__'}");
    expect(substituteCss("a{content:__MSG_noend}", res)).toBe("a{content:__MSG_noend}");
    expect(substituteCss("body{}", res)).toBe("body{}");
  });

  it("resolves the predefined @@ messages, including bidi for an RTL locale", () => {
    const ltr = { locale: "en-US", messages: {} };
    const ar = { locale: "ar", messages: {} };
    expect(substituteCss("body{direction:__MSG_@@bidi_dir__;padding-__MSG_@@bidi_start_edge__:0}", ltr))
      .toBe("body{direction:ltr;padding-left:0}");
    expect(substituteCss("body{direction:__MSG_@@bidi_dir__;padding-__MSG_@@bidi_start_edge__:0}", ar))
      .toBe("body{direction:rtl;padding-right:0}");
    expect(i18nGetMessage({ locale: "en", messages: {} }, "@@ui_locale")).toBe("en");
    expect(i18nGetMessage({ locale: "en", messages: {}, id: "abc@x" }, "@@extension_id")).toBe("abc@x");
  });

  it("serves content-script CSS substituted from the package locales", async () => {
    const manifest = {
      manifest_version: 2,
      name: "CssMsg " + seq++,
      version: "1.0",
      permissions: [],
      default_locale: "en",
      content_scripts: [{ matches: ["https://a.example/*"], js: ["cs.js"], css: ["cs.css"] }],
    };
    const files: Record<string, string> = {
      "_locales/en/messages.json": JSON.stringify({ color: { message: "teal" } }),
      "cs.js": "var a = 1;",
      "cs.css": "div{color:__MSG_color__;border:1px solid __MSG_missing__}",
    };
    const m = new Map<string, Uint8Array>([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
    for (const [k, v] of Object.entries(files)) m.set(k, enc.encode(v));
    await extensions.startup();
    const { id } = await extensions.installFiles(m);
    const url = "https://sw.example" + CS_ROUTE + id + "/cs.css";
    const res = await serveExtensionAsset(new Request(url), new URL(url), {
      nav: false,
      pageUrl: "https://a.example/page.html",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("div{color:teal;border:1px solid __MSG_missing__}");
  });
});

describe("manifest surface localization (#523)", () => {
  it("substitutes __MSG_*__ string fields, keeps literals and never mutates the source", () => {
    const res = {
      locale: "nb",
      messages: messagesFromJson({
        extName: { message: "Utvidelse" },
        v0version0: { message: "v$version$", placeholders: { version: { content: "$1" } } },
      }),
    };
    const manifest = {
      name: "__MSG_extName__",
      description: "__MSG_missing__",
      version: "5.5.0",
      action: { default_title: "__MSG_extName__" },
      arr: ["__MSG_extName__"],
    };
    const out = substituteManifestStrings(manifest, res) as typeof manifest;
    expect(out.name).toBe("Utvidelse");
    expect(out.description).toBe("__MSG_missing__");
    expect(out.action.default_title).toBe("Utvidelse");
    /* Arrays keep their literals: Chrome localizes no array field. */
    expect(out.arr[0]).toBe("__MSG_extName__");
    expect(manifest.name).toBe("__MSG_extName__");
    /* Install-time semantics: $placeholder$ text stays unexpanded. */
    expect(substituteManifestStrings({ v: "__MSG_v0version0__" }, res).v).toBe("v$version$");
  });

  it("serves the pagejs bridge with a localized manifest for a record that predates the name fix (#523)", async () => {
    const manifest = {
      manifest_version: 2,
      name: "__MSG_extName__",
      version: "5.5.0",
      permissions: [],
      default_locale: "en",
    };
    const m = new Map<string, Uint8Array>([
      ["manifest.json", enc.encode(JSON.stringify(manifest))],
      [
        "_locales/en/messages.json",
        enc.encode(JSON.stringify({ extName: { message: "Tampermonkey" } })),
      ],
    ]);
    await extensions.startup();
    const { id } = await extensions.installFiles(m);
    const rec = extensions.get(id)!;
    /* A pre-fix record still carries the raw token on its manifest
       copy (the Tampermonkey 5.5.0 options header rendered
       "__MSG_extName__ by Jan Biniok" from exactly this). */
    (rec.manifest as Record<string, unknown>).name = "__MSG_extName__";
    const url = "https://sw.example" + EXT_ROUTE + id + "/__page.js";
    const served = await serveExtensionAsset(new Request(url), new URL(url));
    expect(served.status).toBe(200);
    const body = await served.text();
    expect(body).not.toContain("__MSG_extName__");
    expect(body).toContain('"name":"Tampermonkey"');
  });

  it("localizes runtime.getManifest from the context locales and keeps literals without them", async () => {
    const files = (v: string) =>
      new Map<string, Uint8Array>([
        [
          "manifest.json",
          enc.encode(
            JSON.stringify({
              manifest_version: 2,
              name: "__MSG_extName__",
              version: v,
              permissions: [],
              default_locale: "en",
            }),
          ),
        ],
        [
          "_locales/en/messages.json",
          enc.encode(JSON.stringify({ extName: { message: "HighSeas" } })),
        ],
      ]);
    await extensions.startup();
    const { id } = await extensions.installFiles(files("1.0"));
    const rec = extensions.get(id)!;
    (rec.manifest as Record<string, unknown>).name = "__MSG_extName__";
    const storage = {
      local: new ExtensionStorageArea(id, "local", "local"),
      sync: new ExtensionStorageArea(id, "sync", "sync"),
      session: new ExtensionStorageArea(id, "session", "session"),
    };
    const i18n = await resolvePackageI18n("en", (p) => extensions.getResource(id, p, { fromWeb: false }));
    const withI18n = buildApi(
      rec,
      { extensionId: id, context: "background", url: null },
      { messenger: new ExtensionMessenger(), storage, i18n },
    );
    const noI18n = buildApi(
      rec,
      { extensionId: id, context: "background", url: null },
      { messenger: new ExtensionMessenger(), storage },
    );
    const get = (api: { chrome: Record<string, unknown> }): unknown =>
      ((api.chrome.runtime as Record<string, unknown>).getManifest as () => Record<string, unknown>)().name;
    expect(get(withI18n)).toBe("HighSeas");
    expect(get(noI18n)).toBe("__MSG_extName__");
  });
});
