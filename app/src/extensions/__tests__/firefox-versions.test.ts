/* #516 slice 4: the Firefox version annotations (firefox-versions.ts)
   held against the FIREFOX_API inventory.

   Invariants:
   1. FIREFOX_VERSIONS + VERSION_GAPS together cover every inventoried
      namespace and member exactly once - neither table can drift from
      the inventory (a new member without an annotation fails here),
   2. the two tables are disjoint and every gap reason is honest,
   3. entries carry the documented shape, and an unsupported member
      never claims an added version,
   4. spot checks pin long-standing APIs to real version numbers - a
      BCD regeneration that changes them fails loudly for review. */
import { describe, expect, it } from "vitest";
import { FIREFOX_API } from "../firefox-inventory";
import { FIREFOX_VERSIONS, VERSION_GAPS, type FirefoxVersionInfo } from "../firefox-versions";

function inventoryPaths(): string[] {
  const out: string[] = [];
  for (const [ns, members] of Object.entries(FIREFOX_API)) {
    out.push(ns);
    for (const mem of Object.keys(members)) out.push(`${ns}.${mem}`);
  }
  return out.sort();
}

describe("Firefox version annotations (#516 slice 4)", () => {
  it("covers every inventoried namespace and member 1:1 across versions + gaps", () => {
    const annotated = [...Object.keys(FIREFOX_VERSIONS), ...Object.keys(VERSION_GAPS)].sort();
    expect(annotated).toEqual(inventoryPaths());
  });

  it("keeps versions and gaps disjoint and gap reasons honest", () => {
    for (const k of Object.keys(FIREFOX_VERSIONS)) {
      expect(VERSION_GAPS[k], `${k} is in both tables`).toBeUndefined();
    }
    for (const [k, why] of Object.entries(VERSION_GAPS)) {
      expect(why.length, `${k} gap reason`).toBeGreaterThan(10);
    }
  });

  it("entries carry the documented shape", () => {
    for (const [k, e] of Object.entries(FIREFOX_VERSIONS) as [string, FirefoxVersionInfo][]) {
      expect(e.added === null || typeof e.added === "string", `${k} added`).toBe(true);
      expect(typeof e.deprecated, `${k} deprecated`).toBe("boolean");
      if (e.unsupported !== undefined) expect(e.unsupported, `${k} unsupported`).toBe(true);
      if (e.removed !== undefined) expect(typeof e.removed, `${k} removed`).toBe("string");
    }
  });

  it("an unsupported member never claims an added version", () => {
    for (const [k, e] of Object.entries(FIREFOX_VERSIONS) as [string, FirefoxVersionInfo][]) {
      if (e.unsupported) expect(e.added, k).toBeNull();
    }
  });

  it("spot checks: long-standing APIs carry real version numbers", () => {
    for (const path of ["alarms", "cookies.getAll", "runtime.onInstalled", "bookmarks.create", "tabs.sendMessage"]) {
      expect(FIREFOX_VERSIONS[path]?.added, path).toMatch(/^\d+$/);
    }
  });
});
