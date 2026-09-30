import { describe, expect, it } from "vitest";
import { classifyFailure, errorPage } from "../errorpage";

describe("classifyFailure (issue #3 categories)", () => {
  it("maps known transport failures honestly", () => {
    expect(classifyFailure("getaddrinfo ENOTFOUND excalidraw.com")).toBe("dns");
    expect(classifyFailure("dns resolution failed")).toBe("dns");
    expect(classifyFailure("tls handshake failed")).toBe("tls");
    expect(classifyFailure("SSL certificate expired")).toBe("tls");
    expect(classifyFailure("connection timed out")).toBe("timeout");
    expect(classifyFailure("ETIMEDOUT")).toBe("timeout");
    expect(classifyFailure("destination blocked by policy: loopback")).toBe("blocked");
    expect(classifyFailure("403 forbidden by upstream policy")).toBe("blocked");
  });

  it("never invents a cause: unknown failures are stream errors", () => {
    expect(classifyFailure("network changed mid-response")).toBe("stream");
    expect(classifyFailure("")).toBe("stream");
    expect(classifyFailure("totally novel error")).toBe("stream");
  });
});

describe("errorPage", () => {
  const page = errorPage({
    route: "/j/aHR0cHM6Ly90YXJnZXQuZGV2L3A",
    category: "dns",
    engineVersion: "2.3 Selenide",
  });

  it("carries the machine-readable zl-error payload", () => {
    expect(page).toContain('name="zl-error"');
    expect(page).toContain("&quot;category&quot;:&quot;dns&quot;");
    expect(page).toContain("&quot;version&quot;:&quot;2.3 Selenide&quot;");
  });

  it("never prints a destination URL (issue #32)", () => {
    expect(page).not.toContain("target.dev");
    expect(page).not.toContain("https://");
  });

  it("escapes hostile route input instead of reflecting it", () => {
    const p = errorPage({
      route: "/j/x\" onerror=\"alert(1)",
      category: "dns",
      engineVersion: "v",
    });
    expect(p).not.toContain("<script>");
    expect(p).not.toContain("onerror=\"alert");
  });

  it("is deterministic, minimal and theme-aware", () => {
    const again = errorPage({
      route: "/j/aHR0cHM6Ly90YXJnZXQuZGV2L3A",
      category: "dns",
      engineVersion: "2.3 Selenide",
    });
    expect(again).toBe(page);
    expect(page).toContain("color-scheme: light dark");
    expect(page).not.toContain("prefers-color-scheme");
    expect(page).toContain('href="/j/aHR0cHM6Ly90YXJnZXQuZGV2L3A"');
  });

  it("one honest line per category, nothing else", () => {
    for (const [cat, text] of [
      ["dns", "could not be found"],
      ["tls", "secure connection failed"],
      ["timeout", "too long to answer"],
      ["blocked", "blocked by policy"],
      ["stream", "interrupted"],
    ] as const) {
      const p = errorPage({ route: "/j/x", category: cat, engineVersion: "v" });
      expect(p).toContain(text);
      expect(p).not.toContain("stack");
    }
  });
});
