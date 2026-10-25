import { describe, expect, it, vi, beforeEach } from "vitest";

/* #449 unit layer: the transform seam that asks the optional wasm
   detector, and the netLog annotation that makes the literal skip
   explainable. The real trigger and the skip live in the rewriter
   (Rust tests) and the browser E2E check (suite/e2e). */

const mockState = vi.hoisted(() => ({ throwIt: false }));

vi.mock("../rewriter_wasm/rewriter_wasm.js", () => {
  class JsRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
    add_injection(_p: string) {}
    set_blocked_hosts(_h: string[]) {}
    set_lazy_images() {}
  }
  class JsCssRewriter {
    process(s: string) {
      return s;
    }
    finish() {
      return "";
    }
  }
  return {
    JsRewriter,
    JsCssRewriter,
    rewriteCss: (css: string) => css,
    rewriteJsBody: (js: string) => js,
    globalsStats: () => "0,0,0",
    hasOriginPinningRegex: (js: string) => {
      if (mockState.throwIt) throw new Error("wasm boom");
      return js.includes("^https?:");
    },
    default: async () => {},
  };
});

import { scriptPinsOrigins } from "../transform";
import { netLog, netLogAnnotateRewrite, netLogPush } from "../netlog";

const PINNED = "var va=/^https?:\\/x/;";
const PLAIN = 'var u="https://a.example/x";';

function row(traceId: string) {
  return {
    method: "GET",
    path: "/j/a",
    dest: "https://a.example/" + traceId + ".js",
    status: 200,
    ms: 1,
    bytes: 1,
    rtype: "SCRIPT",
    transport: "RewriteFallback" as const,
    fallbackReason: "JS_LITERAL_REWRITE_REQUIRED",
    traceId,
    rewritten: "js",
  };
}

describe("#449 origin-pinning seam", () => {
  beforeEach(() => {
    mockState.throwIt = false;
    netLog.length = 0;
    (globalThis as unknown as { self: unknown }).self = {
      location: { origin: "https://engine.example", href: "https://engine.example/sw.js" },
    };
  });

  it("scriptPinsOrigins asks the wasm detector and never throws", async () => {
    await expect(scriptPinsOrigins(PINNED)).resolves.toBe(true);
    await expect(scriptPinsOrigins(PLAIN)).resolves.toBe(false);
    mockState.throwIt = true;
    await expect(scriptPinsOrigins(PINNED)).resolves.toBe(false);
  });

  it("netLogAnnotateRewrite re-annotates the latest row for the traceId", () => {
    netLogPush(row("t1"));
    netLogPush(row("t2"));
    netLogAnnotateRewrite("t2", "js-pinned");
    expect(netLog.find((e) => e.traceId === "t2")?.rewritten).toBe("js-pinned");
    expect(netLog.find((e) => e.traceId === "t1")?.rewritten).toBe("js");
    netLogAnnotateRewrite("unknown", "js-pinned");
    expect(netLog.filter((e) => e.rewritten === "js-pinned")).toHaveLength(1);
  });
});
