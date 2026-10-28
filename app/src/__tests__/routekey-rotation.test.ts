/* #508 audit regression: the route-key rotation lifecycle contract.
   decodePath walks the full decode history (newest first), so a
   route minted before a rotation keeps its decode path; a key that
   left the history (cleared storage, or past the decode-history
   cap) fails closed, which is the branch that produces the
   "undecodable keyed route" 404. Legacy tails stay decodable in
   every key state. No production code changed: this suite pins the
   audited lifecycle so a future regression cannot strand old
   routes silently. */

import { afterEach, describe, expect, it } from "vitest";
import {
  b64uEncode,
  decodePath,
  encodeDest,
  encodeDestLegacy,
  looksKeyedToken,
  setRouteKey,
  setRouteKeys,
} from "../codec";

const KEY_OLD = new Uint8Array(16).map((_, i) => i + 1);
const KEY_NEW = new Uint8Array(16).map((_, i) => i + 17);
const OLD_B64 = b64uEncode(KEY_OLD);
const NEW_B64 = b64uEncode(KEY_NEW);

afterEach(() => {
  setRouteKey(null);
});

describe("route key rotation lifecycle (#508 audit)", () => {
  it("keeps routes minted before a rotation decodable via the decode history", () => {
    setRouteKeys([OLD_B64]);
    const route = encodeDest("https://old.example/img.png");
    /* Restart: the newer key mints new routes; the older key stays
       in the decode history exactly as routeRestore reloads it. */
    setRouteKeys([NEW_B64, OLD_B64]);
    expect(decodePath(route)).toBe("https://old.example/img.png");
    const fresh = encodeDest("https://new.example/x");
    expect(decodePath(fresh)).toBe("https://new.example/x");
  });

  it("fails closed with a keyed-token tail when the minting key left the history", () => {
    setRouteKeys([OLD_B64]);
    const route = encodeDest("https://old.example/img.png");
    setRouteKeys([NEW_B64]);
    expect(decodePath(route)).toBeNull();
    /* The 404 branch distinguishes a stranded keyed token from a
       plain bad tail; the tail must still be recognized as keyed. */
    expect(looksKeyedToken(route)).toBe(true);
  });

  it("decodes legacy routes regardless of the key state", () => {
    setRouteKey(null);
    const legacy = encodeDestLegacy("https://legacy.example/page");
    setRouteKeys([NEW_B64, OLD_B64]);
    expect(decodePath(legacy)).toBe("https://legacy.example/page");
  });
});
