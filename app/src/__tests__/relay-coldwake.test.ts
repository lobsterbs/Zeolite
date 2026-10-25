import { describe, expect, it, vi } from "vitest";
/* #391: an idle-restarted worker asks its clients to re-register at
   worker start, before the first relay fetch pays the 3s wait and
   the 30s backoff (live-measured pre-fix recovery: 33.9s).
   #464: the wake is HOST-ONLY - a proxied page can never register
   the relay (the control gate), so asking it would be noise and a
   privilege-boundary smear. */
import { relayColdWake } from "../relayfetch";

describe("relay cold-wake broadcast (#391)", () => {
  it("asks every HOST window client to re-register (#464)", async () => {
    const posts = new Map<string, unknown[]>();
    const mk = (url: string) => ({
      url,
      postMessage: (m: unknown) => {
        const a = posts.get(url) ?? [];
        a.push(m);
        posts.set(url, a);
      },
    });
    vi.stubGlobal("self", {
      location: { origin: "https://app.example" },
      clients: {
        matchAll: async () => [
          mk("https://app.example/"),
          mk("https://app.example/?zlNavh=qwG1-abc"),
          mk("https://content.example/"),
        ],
      },
    });
    await relayColdWake();
    expect(posts.get("https://app.example/")).toEqual([{ type: "zl:relayLost" }]);
    expect(posts.has("https://app.example/?zlNavh=qwG1-abc")).toBe(false);
    expect(posts.has("https://content.example/")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("degrades honestly without a clients API", async () => {
    vi.stubGlobal("self", {});
    await relayColdWake();
    vi.unstubAllGlobals();
  });
});
