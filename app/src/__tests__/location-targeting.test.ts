/* #456 gate 4 regression tests: the automatic #432-class targeting
   needs corroborated evidence (page-side not-found reports on >= 2
   distinct loads AND observed location-read rewrites), an explicit
   siteconfig rule always wins, the store stays bounded and
   hostname-only, TTL-stale evidence never targets, the host kill
   switch restores the legacy pass, and the injected watcher rides
   the init script without ever carrying the destination. */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseKdl } from "../kdl";
import { rulesFromNodes } from "../siteconfig";
import { PAGE_MESSAGES } from "../cpgate";
import { initScript } from "../pageload";
import {
  LOCATION_TARGET_TTL_MS,
  locationTargetReset,
  locationTargetSnapshot,
  recordDocumentLocationReads,
  recordSpa404Report,
  resolveLocationPolicy,
} from "../location-targeting";
import { setLocationTargeting } from "../swstate";

const markOrigin = () => {
  recordDocumentLocationReads("https://spa.example/app?v=1");
  recordSpa404Report("https://spa.example/app", "client-a");
  recordSpa404Report("https://spa.example/app", "client-b");
};

describe("automatic location targeting (#456 gate 4)", () => {
  beforeEach(() => {
    locationTargetReset();
  });
  afterEach(() => {
    setLocationTargeting(true);
    vi.useRealTimers();
  });

  it("never targets on reports without location reads, or reads without reports", () => {
    /* A generic not-found view without location-reading scripts is
       not the #432 class: no mark even across two distinct loads. */
    recordSpa404Report("https://spa.example/", "client-a");
    recordSpa404Report("https://spa.example/", "client-b");
    expect(resolveLocationPolicy("https://spa.example/", {}).mode).toBe("legacy");
    /* Location reads alone never target either. */
    recordDocumentLocationReads("https://spa.example/");
    expect(resolveLocationPolicy("https://spa.example/", {}).mode).toBe("legacy");
  });

  it("targets only on corroborated evidence: 2 distinct clients + location reads", () => {
    recordDocumentLocationReads("https://spa.example/app");
    recordSpa404Report("https://spa.example/app", "client-a");
    /* The same client again: one load corroborates nothing. */
    recordSpa404Report("https://spa.example/app", "client-a");
    expect(resolveLocationPolicy("https://spa.example/app", {}).mode).toBe("legacy");
    recordSpa404Report("https://spa.example/app", "client-b");
    expect(resolveLocationPolicy("https://spa.example/app", {})).toEqual({ mode: "hybrid", maxBytes: 512 * 1024 });
    /* The mark is per-host: a subdomain does not inherit it. */
    expect(resolveLocationPolicy("https://sub.spa.example/", {}).mode).toBe("legacy");
  });

  it("an explicit siteconfig rule always wins over the learned mark", () => {
    markOrigin();
    const rules = rulesFromNodes(parseKdl('site "spa.example" { location-rewrite "off" }'));
    expect(resolveLocationPolicy("https://spa.example/app", rules["spa.example"]!).mode).toBe("off");
    const hybrid = rulesFromNodes(parseKdl('site "spa.example" { location-rewrite "hybrid" max-bytes=65536 }'));
    expect(resolveLocationPolicy("https://spa.example/app", hybrid["spa.example"]!)).toEqual({ mode: "hybrid", maxBytes: 65536 });
  });

  it("stores hostnames and counters only, never URLs or queries", () => {
    markOrigin();
    const snap = locationTargetSnapshot();
    const e = snap.entries.find((x) => x.origin === "spa.example");
    expect(e).toBeDefined();
    expect(e!.reports).toBe(2);
    expect(e!.locationReads).toBe(1);
    expect(e!.markedAt).not.toBeNull();
    expect(JSON.stringify(snap)).not.toContain("app?v=1");
  });

  it("is bounded and drop-oldest (512 origins)", () => {
    for (let i = 0; i < 513; i++) {
      recordDocumentLocationReads("https://o" + i + ".example/x.js");
    }
    const snap = locationTargetSnapshot();
    expect(snap.origins).toBe(512);
    expect(snap.dropped).toBe(1);
    expect(snap.entries.find((x) => x.origin === "o0.example")).toBeUndefined();
  });

  it("TTL-stale evidence never targets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    markOrigin();
    expect(resolveLocationPolicy("https://spa.example/app", {}).mode).toBe("hybrid");
    vi.setSystemTime(1_000_000 + LOCATION_TARGET_TTL_MS + 1);
    expect(resolveLocationPolicy("https://spa.example/app", {}).mode).toBe("legacy");
  });

  it("the host kill switch restores the legacy pass", () => {
    markOrigin();
    setLocationTargeting(false);
    expect(resolveLocationPolicy("https://spa.example/app", {}).mode).toBe("legacy");
    setLocationTargeting(true);
    expect(resolveLocationPolicy("https://spa.example/app", {}).mode).toBe("hybrid");
  });

  it("the watcher is page-facing and carries no destination", () => {
    expect(PAGE_MESSAGES.has("zl:spa404")).toBe(true);
    const init = initScript("https://leaky.example.org/path?q=1", null);
    expect(init).toContain("zl:spa404");
    expect(init).not.toContain("leaky.example.org");
  });
});
