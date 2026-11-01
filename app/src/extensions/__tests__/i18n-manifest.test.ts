import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";

const enc = new TextEncoder();

/* #523: manifest __MSG_*__ substitution beyond name/description -
   short_name, the action family default_title, sidebar_action
   default_title, commands descriptions - plus case-folded message
   lookup and the Firefox rule that __MSG_*__ without default_locale
   is an install error. */

function pkg(manifest: Record<string, unknown>, messages: Record<string, unknown> | null): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
  if (messages) {
    files.set("_locales/en/messages.json", enc.encode(JSON.stringify(messages)));
  }
  return files;
}

async function install(manifest: Record<string, unknown>, messages: Record<string, unknown> | null) {
  await extensions.startup();
  return extensions.installFiles(pkg(manifest, messages));
}

const BASE = { manifest_version: 3, name: "T", version: "1.0" };

describe("manifest i18n substitution beyond name/description (#523)", () => {
  it("resolves action default_title, sidebar default_title, short_name and command descriptions", async () => {
    const r = await install(
      {
        ...BASE,
        default_locale: "en",
        short_name: "__MSG_shortNm__",
        action: { default_title: "__MSG_actTitle__", default_popup: "pop.html" },
        sidebar_action: { default_title: "__MSG_sideTitle__", default_panel: "side.html" },
        commands: {
          _execute_action: { suggested_key: { default: "Ctrl+Shift+Y" }, description: "__MSG_cmdDesc__" },
        },
      },
      {
        shortNm: { message: "Shorty" },
        actTitle: { message: "Action Title" },
        sideTitle: { message: "Sidebar Title" },
        cmdDesc: { message: "Do the thing" },
      },
    );
    expect(r.id).toBeTruthy();
    const rec = extensions.get(r.id)!;
    expect((rec.manifest as Record<string, unknown>).short_name).toBe("Shorty");
    expect(rec.action!.defaultTitle).toBe("Action Title");
    expect((rec.manifest as Record<string, unknown>).action).toMatchObject({ default_title: "Action Title" });
    expect(rec.sidebarAction!.defaultTitle).toBe("Sidebar Title");
    const cmds = (rec.manifest as Record<string, unknown>).commands as Record<string, { description?: string }>;
    expect(cmds._execute_action.description).toBe("Do the thing");
  });

  it("folds message-name case, as Chrome folds at runtime", async () => {
    const r = await install(
      { ...BASE, default_locale: "en", action: { default_title: "__MSG_action_title__" } },
      { ACTION_TITLE: { message: "Folded" } },
    );
    const rec = extensions.get(r.id)!;
    expect(rec.action!.defaultTitle).toBe("Folded");
  });

  it("rejects __MSG_*__ without default_locale as Firefox does", async () => {
    await expect(
      install({ ...BASE, name: "__MSG_noLocale__" }, null),
    ).rejects.toThrow(/default_locale/);
  });

  it("still warns and keeps the literal when a key is missing (documented lenience)", async () => {
    const r = await install(
      { ...BASE, default_locale: "en", name: "Base", action: { default_title: "__MSG_missing__" } },
      { other: { message: "x" } },
    );
    expect(r.warnings.some((w) => w.startsWith("action.default_title: __MSG_*__ placeholder"))).toBe(true);
    const rec = extensions.get(r.id)!;
    expect(rec.action!.defaultTitle).toBe("__MSG_missing__");
  });
});
