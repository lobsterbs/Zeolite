import { describe, it, expect } from "vitest";
import { pluginNameOk, loadPlugin, applyOnRequest, applyOnResponse } from "../plugins";
import { REGISTRY } from "../plugins/registry";
import { DIAG } from "../diag";

function diagCount(marker: string): number {
  return DIAG.snapshot(0).events.filter((e) => e.message.includes(marker)).length;
}

describe("plugin name validation (#97)", () => {
  it("accepts only plain [A-Za-z0-9_-] names", () => {
    expect(pluginNameOk("adblock")).toBe(true);
    expect(pluginNameOk("my-plugin_2")).toBe(true);
    expect(pluginNameOk("sample-observer")).toBe(true);
    expect(pluginNameOk("../evil")).toBe(false);
    expect(pluginNameOk("a/b")).toBe(false);
    expect(pluginNameOk("..%2fevil")).toBe(false);
    expect(pluginNameOk("https://evil.example/p")).toBe(false);
    expect(pluginNameOk("")).toBe(false);
  });

  it("never attempts a load for crafted names", async () => {
    expect(await loadPlugin("../../escape")).toBeNull();
    expect(await loadPlugin("https://evil.example/p.js")).toBeNull();
  });
});

describe("static registry loader (#256)", () => {
  it("resolves a shipped plugin to memoized hooks", async () => {
    const h1 = await loadPlugin("sample-observer");
    const h2 = await loadPlugin("sample-observer");
    expect(h1).not.toBeNull();
    expect(h1).toBe(h2);
    expect(typeof h1?.onResponse).toBe("function");
  });

  it("unknown names fail safely to null with ONE bounded warning", async () => {
    const marker = "not-in-the-registry";
    const before = diagCount(marker);
    expect(await loadPlugin(marker)).toBeNull();
    expect(await loadPlugin(marker)).toBeNull();
    expect(diagCount(marker) - before).toBe(1);
  });

  it("a throwing register() is isolated and degrades to null", async () => {
    REGISTRY["broken-for-test"] = () => {
      throw new Error("boom");
    };
    try {
      expect(await loadPlugin("broken-for-test")).toBeNull();
    } finally {
      delete REGISTRY["broken-for-test"];
    }
  });
});

describe("hook application (#256)", () => {
  it("onRequest applies returned headers; other targets are untouched", async () => {
    REGISTRY["header-for-test"] = (hooks) => {
      hooks.onRequest = ({ url, headers }) =>
        url.startsWith("https://plugin.test/") ? { headers: { ...headers, "x-plugin": "applied" } } : undefined;
    };
    try {
      const hit = new Headers({ a: "b" });
      await applyOnRequest(["header-for-test"], "https://plugin.test/page", hit);
      expect(hit.get("x-plugin")).toBe("applied");
      expect(hit.get("a")).toBe("b");
      const miss = new Headers({ a: "b" });
      await applyOnRequest(["header-for-test"], "https://other.test/", miss);
      expect(miss.get("x-plugin")).toBe(null);
    } finally {
      delete REGISTRY["header-for-test"];
    }
  });

  it("a throwing onRequest hook never breaks the request path", async () => {
    REGISTRY["throw-req-for-test"] = (hooks) => {
      hooks.onRequest = () => {
        throw new Error("boom");
      };
    };
    try {
      const h = new Headers({ keep: "me" });
      await applyOnRequest(["throw-req-for-test"], "https://plugin.test/", h);
      expect(h.get("keep")).toBe("me");
    } finally {
      delete REGISTRY["throw-req-for-test"];
    }
  });

  it("onResponse hooks are best-effort observers: throws isolated, sample-observer emits once", async () => {
    REGISTRY["throw-res-for-test"] = (hooks) => {
      hooks.onResponse = () => {
        throw new Error("boom");
      };
    };
    try {
      const marker = "sample-observer plugin loaded and saw a response";
      const before = diagCount(marker);
      await applyOnResponse(["throw-res-for-test", "sample-observer"], "https://plugin.test/", 200, new Headers({ a: "b" }));
      await applyOnResponse(["sample-observer"], "https://plugin.test/second", 200, new Headers());
      expect(diagCount(marker) - before).toBe(1);
    } finally {
      delete REGISTRY["throw-res-for-test"];
    }
  });
});
