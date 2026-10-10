import { describe, expect, it, beforeEach } from "vitest";
import { isFlatPath, recordAssetBase, recoverFlatAsset, resetAssetBases } from "../assetbases";

const mkResp = (status: number, ct: string) =>
  new Response("body", { status, headers: { "content-type": ct } });

describe("asset base registry (#134)", () => {
  beforeEach(() => resetAssetBases());

  it("records cross-origin asset directories per page origin", async () => {
    recordAssetBase("https://github.com/", "https://github.githubassets.com/assets/app.js");
    const seen: string[] = [];
    const fetchUpstream = async (u: string) => {
      seen.push(u);
      return mkResp(200, "text/css");
    };
    const rec = await recoverFlatAsset(
      "https://github.com/",
      "https://github.com/xy4.86babbfb1b89d634.module.css",
      "style",
      new Headers(),
      fetchUpstream,
    );
    expect(rec?.url).toBe("https://github.githubassets.com/assets/xy4.86babbfb1b89d634.module.css");
    expect(seen).toEqual(["https://github.githubassets.com/assets/xy4.86babbfb1b89d634.module.css"]);
    expect(rec?.resp.status).toBe(200);
  });

  it("ignores same-origin, empty, and malformed entries", async () => {
    recordAssetBase("https://a.example/", "https://a.example/assets/x.js");
    recordAssetBase("", "https://cdn.example/assets/x.js");
    recordAssetBase("https://a.example/", "not a url");
    const rec = await recoverFlatAsset(
      "https://a.example/",
      "https://a.example/flat.module.css",
      "style",
      new Headers(),
      async () => mkResp(200, "text/css"),
    );
    expect(rec).toBeNull();
  });

  it("dedupes and refreshes recency, caps per-origin entries", async () => {
    for (let i = 0; i < 6; i++) {
      recordAssetBase("https://p.example/", "https://cdn" + i + ".example/assets/x.js");
    }
    recordAssetBase("https://p.example/", "https://cdn5.example/assets/x.js");
    recordAssetBase("https://p.example/", "https://cdn4.example/assets/y.js");
    const order: string[] = [];
    await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/flat.css",
      "style",
      new Headers(),
      async (u) => {
        order.push(u);
        return mkResp(404, "text/plain");
      },
    );
    /* Only the freshest bases are tried, newest first: cdn4 (refreshed),
       cdn5, then cdn3 - the cap keeps 4 and the refresh moved cdn4. */
    expect(order[0]).toContain("https://cdn4.example/assets/flat.css");
    expect(order[1]).toContain("https://cdn5.example/assets/flat.css");
    expect(order[2]).toContain("https://cdn3.example/assets/flat.css");
    expect(order.length).toBe(3);
  });

  it("requires a flat single-segment path", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/assets/deep/flat.css",
      "style",
      new Headers(),
      async () => mkResp(200, "text/css"),
    );
    expect(rec).toBeNull();
    expect(isFlatPath("/a.module.css")).toBe(true);
    expect(isFlatPath("/a/b.module.css")).toBe(false);
  });

  it("rejects wrong-MIME and non-OK candidates, keeps trying", async () => {
    recordAssetBase("https://p.example/", "https://bad.example/assets/x.js");
    recordAssetBase("https://p.example/", "https://good.example/assets/x.js");
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/flat.module.css",
      "style",
      new Headers(),
      async (u) => (u.startsWith("https://good") ? mkResp(200, "text/css") : mkResp(200, "text/plain")),
    );
    expect(rec?.url).toBe("https://good.example/assets/flat.module.css");
  });

  it("never forwards cookies, origin or referer to the candidate", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    const h = new Headers({
      cookie: "secret=1",
      origin: "https://p.example",
      referer: "https://p.example/",
      "user-agent": "test-agent",
    });
    const seenRef: { h?: Headers } = {};
    await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/flat.css",
      "style",
      h,
      async (_u, init) => {
        seenRef.h = init.headers;
        return mkResp(200, "text/css");
      },
    );
    expect(seenRef.h?.get("cookie")).toBeNull();
    expect(seenRef.h?.get("origin")).toBeNull();
    expect(seenRef.h?.get("referer")).toBeNull();
    expect(seenRef.h?.get("user-agent")).toBe("test-agent");
  });

  it("refuses document and worker destinations", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/flat.css",
      "document",
      new Headers(),
      async () => mkResp(200, "text/html"),
    );
    expect(rec).toBeNull();
  });

  it("recovers a runtime-built binary fetch (dest empty, glb)", async () => {
    recordAssetBase("https://github.com/", "https://github.githubassets.com/assets/app.js");
    const rec = await recoverFlatAsset(
      "https://github.com/",
      "https://github.com/shield-99c76cd962f04df2.glb",
      "empty",
      new Headers(),
      async () => mkResp(200, "application/octet-stream"),
    );
    expect(rec?.url).toBe("https://github.githubassets.com/assets/shield-99c76cd962f04df2.glb");
  });

  it("refuses extension-less fetch misses (beacon shape), no retries", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    let calls = 0;
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/collect",
      "empty",
      new Headers(),
      async () => {
        calls++;
        return mkResp(200, "application/json");
      },
    );
    expect(rec).toBeNull();
    expect(calls).toBe(0);
  });

  it("refuses an HTML candidate for a fetch recovery", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/blob.frag",
      "empty",
      new Headers(),
      async () => mkResp(200, "text/html"),
    );
    expect(rec).toBeNull();
  });

  it("recovers an image destination flat miss", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/hero-99c76cd962f04df2.png",
      "image",
      new Headers(),
      async () => mkResp(200, "image/png"),
    );
    expect(rec?.url).toBe("https://cdn.example/assets/hero-99c76cd962f04df2.png");
  });
});
