import { describe, expect, it } from "vitest";
import { b64uEncode, decodePath, encodeDest, encodeDestLegacy, setRouteKey, setRouteKeys } from "../codec";

/* The stranded-route half of #55: a restart that mints a fresh key
   must not strand routes already minted under old keys. setRouteKeys
   installs the full decode history (newest first); decodePath tries
   each key, and minting always uses the newest. */
describe("route key history (#55)", () => {
  const keyA = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  const keyB = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));

  it("decodes routes minted under a rotated key via the history", () => {
    setRouteKey(keyA);
    const route = encodeDest("https://example.com/page");
    /* rotation: keyB is current for minting, keyA stays decodable */
    setRouteKeys([keyB, keyA]);
    expect(encodeDest("https://example.com/other")).not.toBe(route);
    expect(decodePath(route)).toBe("https://example.com/page");
  });

  it("mints with the newest key and fails closed for unknown tokens", () => {
    setRouteKeys([keyB, keyA]);
    expect(decodePath(encodeDest("https://example.com/fresh"))).toBe(
      "https://example.com/fresh",
    );
    /* a token minted under a key that is nowhere in the history fails
       closed, exactly like a rotated-away deployment before this fix */
    setRouteKey(keyA);
    const stranded = encodeDest("https://example.com/lost");
    setRouteKeys([keyB]);
    expect(decodePath(stranded)).toBeNull();
  });

  it("keeps legacy tails decoding regardless of key state", () => {
    setRouteKeys([keyB]);
    const legacy = encodeDestLegacy("https://example.com/legacy");
    expect(decodePath(legacy)).toBe("https://example.com/legacy");
    setRouteKey(null);
    expect(decodePath(legacy)).toBe("https://example.com/legacy");
  });
});
