import { describe, expect, it, vi } from "vitest";
/* #391: an idle-restarted worker asks its clients to re-register at
   worker start, before the first relay fetch pays the 3s wait and
   the 30s backoff (live-measured pre-fix recovery: 33.9s). */
import { relayColdWake } from "../relayfetch";

describe("relay cold-wake broadcast (#391)", () => {
  it("asks every window client to re-register", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("self", {
      clients: {
        matchAll: async () => [
          { postMessage: (m: unknown) => void posted.push(m) },
          { postMessage: (m: unknown) => void posted.push(m) },
        ],
      },
    });
    await relayColdWake();
    expect(posted).toEqual([{ type: "zl:relayLost" }, { type: "zl:relayLost" }]);
    vi.unstubAllGlobals();
  });

  it("degrades honestly without a clients API", async () => {
    vi.stubGlobal("self", {});
    await relayColdWake();
    vi.unstubAllGlobals();
  });
});
