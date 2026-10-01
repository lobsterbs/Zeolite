import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { buildApi } from "../runtime";
import { ExtensionMessenger } from "../messaging";
import { ExtensionStorageArea } from "../storage";
import { NOTIFY } from "../notifications";
import type { ExtensionRecord } from "../types";

const enc = new TextEncoder();

function pkg(name: string, perms: string[]): Map<string, Uint8Array> {
  const manifest = { manifest_version: 2, name, version: "1.0", permissions: perms };
  return new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest))],
  ]);
}

async function install(
  name: string,
  perms: string[],
): Promise<{ rec: ExtensionRecord; api: { browser: Record<string, unknown>; chrome: Record<string, unknown> } }> {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name, perms));
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

describe("browser.notifications", () => {
  it("hands creates to the host with generated or explicit ids and a 2-button cap", async () => {
    const { rec, api } = await install("NotifyExt", ["notifications"]);
    const ops: unknown[] = [];
    NOTIFY.setDispatch((op) => ops.push(op));
    const n = api.browser.notifications as Record<string, unknown>;
    const id1 = await (n.create as (a: unknown, b?: unknown) => Promise<string>)({
      title: "T",
      message: "M",
      iconUrl: "i.png",
      buttons: [{ title: "A" }, { title: "B" }, { title: "C" }],
    });
    expect(id1).toMatch(/^n\d+$/);
    expect(ops[0]).toMatchObject({
      op: "create",
      extId: rec.id,
      id: id1,
      notification: {
        title: "T",
        message: "M",
        iconUrl: "i.png",
        buttons: [{ title: "A" }, { title: "B" }],
      },
    });
    const id2 = await (n.create as (a: unknown, b?: unknown) => Promise<string>)("named", {
      title: "T2",
      message: "M2",
    });
    expect(id2).toBe("named");
    NOTIFY.setDispatch(null);
  });

  it("is mounted only with the notifications permission", async () => {
    const { api } = await install("NoNotify", []);
    expect(api.browser.notifications).toBeUndefined();
  });

  it("requires title and message", async () => {
    const { api } = await install("NotifyBad", ["notifications"]);
    const n = api.browser.notifications as Record<string, unknown>;
    await expect(
      (n.create as (a: unknown, b?: unknown) => Promise<string>)({ title: "x" }),
    ).rejects.toThrow(/title and message/);
  });

  it("events fire from host reports and close removes the entry", async () => {
    const { rec, api } = await install("NotifyEv", ["notifications"]);
    NOTIFY.setDispatch(() => undefined);
    const n = api.browser.notifications as Record<string, unknown>;
    const id = await (n.create as (a: unknown, b?: unknown) => Promise<string>)("x", {
      title: "t",
      message: "m",
    });
    const clicked: unknown[] = [];
    const closed: unknown[] = [];
    const buttons: unknown[] = [];
    ((n.onClicked as { addListener: (l: (i: string) => void) => void }).addListener)((i) =>
      clicked.push(i),
    );
    ((n.onClosed as { addListener: (l: (i: string, byUser: boolean) => void) => void }).addListener)(
      (i, byUser) => closed.push([i, byUser]),
    );
    (
      (n.onButtonClicked as { addListener: (l: (i: string, bi: number) => void) => void }).addListener
    )((i, bi) => buttons.push([i, bi]));
    expect(NOTIFY.event(rec.id, id, "buttonClicked", 1)).toBe(true);
    expect(NOTIFY.event("not-this-ext", id, "clicked")).toBe(false);
    expect(NOTIFY.event(rec.id, "unknown", "clicked")).toBe(false);
    expect(NOTIFY.event(rec.id, id, "clicked")).toBe(true);
    expect(NOTIFY.event(rec.id, id, "closed")).toBe(true);
    /* close removed the entry: further reports match nothing */
    expect(NOTIFY.event(rec.id, id, "clicked")).toBe(false);
    expect(NOTIFY.exists(rec.id, id)).toBe(false);
    expect(clicked).toEqual([id]);
    expect(buttons).toEqual([[id, 1]]);
    expect(closed).toEqual([[id, true]]);
    NOTIFY.setDispatch(null);
  });

  it("update/clear/getAll respect ownership", async () => {
    const a = await install("NotifyOwn1", ["notifications"]);
    const b = await install("NotifyOwn2", ["notifications"]);
    NOTIFY.setDispatch(() => undefined);
    const na = a.api.browser.notifications as Record<string, unknown>;
    const nb = b.api.browser.notifications as Record<string, unknown>;
    await (na.create as (a: unknown, b?: unknown) => Promise<string>)("own", {
      title: "t",
      message: "m",
    });
    expect(
      await (nb.clear as (i: string) => Promise<boolean>)("own"),
    ).toBe(false);
    expect(
      await (nb.update as (i: string, o: Record<string, unknown>) => Promise<boolean>)("own", {
        title: "z",
      }),
    ).toBe(false);
    expect(
      await (na.update as (i: string, o: Record<string, unknown>) => Promise<boolean>)("own", {
        title: "z",
      }),
    ).toBe(true);
    expect(await (na.getAll as () => Promise<Record<string, unknown>>)()).toEqual({
      own: { title: "z", message: "m" },
    });
    expect(await (na.clear as (i: string) => Promise<boolean>)("own")).toBe(true);
    expect(await (na.clear as (i: string) => Promise<boolean>)("own")).toBe(false);
    NOTIFY.setDispatch(null);
  });
});
