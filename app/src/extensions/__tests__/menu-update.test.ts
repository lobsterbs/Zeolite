import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { extensions } from "../manager";
import { MENUS, type MenuClickInfo } from "../contextmenus";

const enc = new TextEncoder();

/* #519: Firefox menus.update/remove semantics, duplicate-id rejection,
   checkbox/radio click state transitions, and OnClickData enrichment.
   The registry is driven directly (real module, no mocks). */

function pkg(name: string): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: 2,
    name,
    version: "1.0",
    permissions: ["contextMenus"],
  };
  return new Map([["manifest.json", enc.encode(JSON.stringify(manifest))]]);
}

async function install(name: string) {
  await extensions.startup();
  const { id } = await extensions.installFiles(pkg(name));
  return { id, rec: extensions.get(id)! };
}

describe("menus.update (#519)", () => {
  it("merges properties into an existing item", async () => {
    const { id, rec } = await install("MenuUpdate");
    MENUS.create(rec, { id: "a", title: "Alpha" });
    MENUS.update(id, "a", { title: "Beta", contexts: ["link"], enabled: false });
    const item = MENUS.itemsFor(id).find((x) => x.id === "a")!;
    expect(item.title).toBe("Beta");
    expect(item.contexts).toEqual(["link"]);
    expect(item.enabled).toBe(false);
  });

  it("rejects an unknown id, as Firefox rejects", async () => {
    const { id } = await install("MenuUpdateUnknown");
    expect(() => MENUS.update(id, "nope", { title: "X" })).toThrow(/no item with id/);
  });

  it("validates checked against the item type and re-parents cycle-safely", async () => {
    const { id, rec } = await install("MenuUpdateChecked");
    MENUS.create(rec, { id: "p", title: "Parent" });
    MENUS.create(rec, { id: "c", title: "Child", parentId: "p" });
    expect(() => MENUS.update(id, "c", { checked: true })).toThrow(/checkbox\/radio/);
    MENUS.create(rec, { id: "cb", title: "Box", type: "checkbox" });
    MENUS.update(id, "cb", { checked: true });
    expect(MENUS.itemsFor(id).find((x) => x.id === "cb")!.checked).toBe(true);
    /* c cannot move under its own child; cb can move under p. */
    expect(() => MENUS.update(id, "p", { parentId: "c" })).toThrow(/descendant/);
    MENUS.update(id, "cb", { parentId: "p" });
    expect(MENUS.itemsFor(id).find((x) => x.id === "cb")!.parentId).toBe("p");
  });
});

describe("menus.remove (#519)", () => {
  it("removes a parent and its subtree", async () => {
    const { id, rec } = await install("MenuRemoveTree");
    MENUS.create(rec, { id: "p", title: "Parent" });
    MENUS.create(rec, { id: "c1", title: "C1", parentId: "p" });
    MENUS.create(rec, { id: "c2", title: "C2", parentId: "p" });
    MENUS.create(rec, { id: "g", title: "Grandchild", parentId: "c1" });
    MENUS.create(rec, { id: "keep", title: "Keep" });
    MENUS.remove(id, "p");
    const left = MENUS.itemsFor(id).map((x) => x.id);
    expect(left).toEqual(["keep"]);
  });

  it("rejects an unknown id instead of staying silent", async () => {
    const { id } = await install("MenuRemoveUnknown");
    expect(() => MENUS.remove(id, "ghost")).toThrow(/no item with id/);
  });
});

describe("menus.create duplicate id (#519)", () => {
  it("rejects a duplicate id in the extension's item space", async () => {
    const { rec } = await install("MenuDup");
    MENUS.create(rec, { id: "dup", title: "One" });
    expect(() => MENUS.create(rec, { id: "dup", title: "Two" })).toThrow(/duplicate id/);
  });
});

describe("menu click state transitions (#519)", () => {
  it("checkbox clicks toggle checked and report checked/wasChecked", async () => {
    const { id, rec } = await install("MenuCheckToggle");
    MENUS.create(rec, { id: "box", title: "Box", type: "checkbox", checked: false });
    const seen: MenuClickInfo[] = [];
    MENUS.onClicked(id, (info) => seen.push(info));
    MENUS.click(id, { menuItemId: "box", pageUrl: "https://page.example/" }, { id: 7 });
    MENUS.click(id, { menuItemId: "box", pageUrl: "https://page.example/" }, { id: 7 });
    expect(seen[0].checked).toBe(true);
    expect(seen[0].wasChecked).toBe(false);
    expect(seen[1].checked).toBe(false);
    expect(seen[1].wasChecked).toBe(true);
    const item = MENUS.itemsFor(id).find((x) => x.id === "box")!;
    expect(item.checked).toBe(false);
  });

  it("radio clicks take exclusive checked state within the same parent", async () => {
    const { id, rec } = await install("MenuRadio");
    MENUS.create(rec, { id: "grp", title: "Group" });
    MENUS.create(rec, { id: "r1", title: "R1", type: "radio", parentId: "grp", checked: true });
    MENUS.create(rec, { id: "r2", title: "R2", type: "radio", parentId: "grp" });
    const seen: MenuClickInfo[] = [];
    MENUS.onClicked(id, (info) => seen.push(info));
    MENUS.click(id, { menuItemId: "r2", pageUrl: "https://page.example/" }, null);
    const r1 = MENUS.itemsFor(id).find((x) => x.id === "r1")!;
    const r2 = MENUS.itemsFor(id).find((x) => x.id === "r2")!;
    expect(r1.checked).toBe(false);
    expect(r2.checked).toBe(true);
    expect(seen[0].checked).toBe(true);
    expect(seen[0].wasChecked).toBe(false);
    expect(seen[0].parentId).toBe("grp");
  });
});

describe("OnClickData enrichment (#519)", () => {
  it("forwards validated host-reported fields and drops junk", async () => {
    const { id, rec } = await install("MenuEnrich");
    MENUS.create(rec, { id: "open", title: "Open" });
    const seen: MenuClickInfo[] = [];
    MENUS.onClicked(id, (info) => seen.push(info));
    MENUS.click(
      id,
      {
        menuItemId: "open",
        pageUrl: "https://page.example/",
        modifiers: ["Shift", "NOT_A_MOD", 42 as unknown as string],
        selectionText: "hello",
        linkUrl: "https://target.example/x",
        frameId: 2,
        editable: false,
        documentUrl: "https://page.example/doc",
      },
      { id: 7 },
    );
    const info = seen[0];
    expect(info.modifiers).toEqual(["Shift"]);
    expect(info.selectionText).toBe("hello");
    expect(info.linkUrl).toBe("https://target.example/x");
    expect(info.frameId).toBe(2);
    expect(info.editable).toBe(false);
    expect(info.documentUrl).toBe("https://page.example/doc");
    expect((info as unknown as Record<string, unknown>).NOT_A_MOD).toBeUndefined();
    /* No checked/wasChecked/parentId keys for a plain item click. */
    expect("checked" in info).toBe(false);
    expect("parentId" in info).toBe(false);
  });
});
