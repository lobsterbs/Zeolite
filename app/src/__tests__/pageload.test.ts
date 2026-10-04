import { afterEach, describe, expect, it } from "vitest";
import { initScript, siteToken, initSplicePoint } from "../pageload";
import { b64uEncode, setRouteKey } from "../codec";

const DEST = "https://real.site/deep/page?q=1";
const DEST2 = "https://other.site/";

describe("siteToken (issue #32)", () => {
  it("is stable per site across pages and reloads", () => {
    expect(siteToken(DEST)).toBe(siteToken("https://real.site/other"));
    expect(siteToken(DEST)).toBe(siteToken(DEST));
  });

  it("differs between sites and never reveals the origin", () => {
    const a = siteToken(DEST);
    const b = siteToken(DEST2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9]+$/);
    expect(a).not.toContain("real.site");
  });

  it("falls back to one stable token for opaque destinations", () => {
    expect(siteToken("about:blank")).toBe(siteToken("data:text/plain,hi"));
    expect(siteToken("")).toMatch(/^[a-z0-9]+$/);
  });
});
describe("initScript (issue #32)", () => {
  it("injects the opaque site identity, never the destination", () => {
    const s = initScript(DEST, null);
    expect(s).toMatch(/^<script>window\.__ZL=\{"site":"[a-z0-9]+"\};<\/script>$/);
    expect(s).not.toContain("real.site");
    expect(s).not.toContain(DEST);
  });

  it("rides the fingerprint profile on the same first chunk", () => {
    const s = initScript(DEST, "/*fp*/");
    expect(s).toBe(
      '<script>window.__ZL={"site":"' + siteToken(DEST) + '"};</script><script>/*fp*/</script>',
    );
  });
});

/* #55 follow-up: the site token is a keyed MAC when a route key is
   active, fnv1a only in the keyless degraded mode. */
describe("siteToken (keyed mode)", () => {
  const KEY = b64uEncode(new Uint8Array(16).fill(0x5a));

  afterEach(() => setRouteKey(null));

  it("mints a keyed token no origin dictionary can reverse", () => {
    setRouteKey(KEY);
    const a = siteToken(DEST);
    expect(a).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(a).not.toBe(siteToken(DEST2));
    expect(a).not.toContain("real.site");
  });

  it("stays stable per origin and rotates with the key", () => {
    setRouteKey(KEY);
    const a = siteToken(DEST);
    expect(a).toBe(siteToken("https://real.site/other"));
    setRouteKey(b64uEncode(new Uint8Array(16).fill(0x7f)));
    expect(siteToken(DEST)).not.toBe(a);
  });

  it("falls back to the fnv1a token without a key (degraded mode)", () => {
    const legacy = siteToken(DEST);
    setRouteKey(KEY);
    const keyed = siteToken(DEST);
    expect(keyed).not.toBe(legacy);
    setRouteKey(null);
    expect(siteToken(DEST)).toBe(legacy);
  });

  it("initScript injects the keyed identity, never the destination", () => {
    setRouteKey(KEY);
    const s = initScript(DEST, null);
    expect(s).toBe('<script>window.__ZL={"site":"' + siteToken(DEST) + '"};</script>');
    expect(s).not.toContain("real.site");
    expect(s).not.toContain(DEST);
  });
});

/* Quirks fix (issue A): the init script must splice AFTER the doctype -
   a script start tag before <!doctype html> puts the parser in quirks
   mode and the doctype is then ignored. Doctype-less documents keep
   the stream-start placement (index 0) so they stay in quirks mode,
   no accidental upgrade. */
describe("initSplicePoint (quirks fix)", () => {
  it("splices after a leading doctype", () => {
    expect(initSplicePoint("<!doctype html><html>")).toBe(15);
    expect(initSplicePoint("<!DOCTYPE HTML>\n<html>")).toBe(15);
    expect(initSplicePoint('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><html>')).toBe(50);
  });

  it("skips leading BOM, whitespace and comments", () => {
    expect(initSplicePoint("﻿<!doctype html><p>")).toBe(16);
    expect(initSplicePoint("  \n\t<!doctype html><p>")).toBe(19);
    expect(initSplicePoint("<!-- hi -->\n<!doctype html><p>")).toBe(27);
    expect(initSplicePoint("<!--a--><!--b--><!doctype html>")).toBe(31);
  });

  it("returns null while a doctype is split across chunks", () => {
    expect(initSplicePoint("<!doctype ht")).toBeNull();
    expect(initSplicePoint("<!doctype html")).toBeNull(); /* no ">" yet */
    expect(initSplicePoint("  <!-- st")).toBeNull(); /* comment not closed */
    expect(initSplicePoint("<!")).toBeNull(); /* could still grow into a doctype */
    expect(initSplicePoint("")).toBeNull();
  });

  it("decides at end of stream what the held head could not", () => {
    expect(initSplicePoint("<!doctype ht", true)).toBe(0);
    expect(initSplicePoint("  <!-- st", true)).toBe(0);
    expect(initSplicePoint("", true)).toBe(0);
  });

  it("places at stream start when no doctype can follow", () => {
    expect(initSplicePoint("<p>hello")).toBe(0);
    expect(initSplicePoint("plain text")).toBe(0);
    expect(initSplicePoint("<!CDATA[x")).toBe(0); /* not a doctype */
    expect(initSplicePoint("<!-- c --><div>")).toBe(0); /* comment then element, no doctype */
  });
});
