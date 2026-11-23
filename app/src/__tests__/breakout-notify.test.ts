import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastBreakout } from "../updates";

/* #706: a breakout-required mark must be pushed to the shell's host
   pages (and only them) as a zl:breakout message, and request.ts must
   fire that push at the mark it already stamps into the netlog and
   tracing ring. Host pages only mirrors the control-plane gate: a
   proxied page in a different tab must not learn another tab's
   destination. */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("broadcastBreakout (#706)", () => {
  const stub = (urls: string[]) => {
    const posted: Record<string, unknown[]> = {};
    vi.stubGlobal("self", {
      location: { origin: "https://e.example" },
      clients: {
        matchAll: async () =>
          urls.map((u) => ({
            url: u,
            postMessage: (m: unknown) => {
              posted[u] = posted[u] ?? [];
              posted[u].push(m);
            },
          })),
      },
    });
    return posted;
  };

  it("posts zl:breakout to host pages only, never proxied or foreign clients", async () => {
    const posted = stub([
      "https://e.example/",
      "https://e.example/index.html",
      "https://e.example/app/accounts.example/",
      "https://other.example/",
      "about:blank",
    ]);
    await broadcastBreakout("https://accounts.google.com/", "google-auth");
    const msg = { type: "zl:breakout", dest: "https://accounts.google.com/", rule: "google-auth" };
    expect(posted["https://e.example/"]).toEqual([msg]);
    expect(posted["https://e.example/index.html"]).toEqual([msg]);
    expect(posted["https://e.example/app/accounts.example/"]).toBeUndefined();
    expect(posted["https://other.example/"]).toBeUndefined();
    expect(posted["about:blank"]).toBeUndefined();
  });

  it("request.ts fires the broadcast at the policy mark (source contract)", () => {
    const src = readFileSync(new URL("../request.ts", import.meta.url), "utf8");
    expect(src).toContain("broadcastBreakout(target, breakoutRule.id)");
  });
});
