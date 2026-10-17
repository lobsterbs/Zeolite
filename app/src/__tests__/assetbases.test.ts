import { describe, expect, it, beforeEach } from "vitest";
import { assetBaseCount, isFlatPath, isRecoverableAssetPath, recordAssetBase, recoverFlatAsset, resetAssetBases } from "../assetbases";

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
    expect(order[3]).toContain("https://cdn2.example/assets/flat.css");
    /* #259: maxTries now walks every recorded base (the per-origin cap). */
    expect(order.length).toBe(4);
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

describe("directory-minted flat names (#143)", () => {
  beforeEach(() => resetAssetBases());

  it("recovers a chunk css minted against the page directory (github repo pages)", async () => {
    recordAssetBase("https://github.com/", "https://github.githubassets.com/assets/app.js");
    const rec = await recoverFlatAsset(
      "https://github.com/",
      "https://github.com/lobsterbs/react-core.3792087592bf207a.module.css",
      "style",
      new Headers(),
      async (u) => {
        if (u === "https://github.githubassets.com/assets/react-core.3792087592bf207a.module.css")
          return new Response("body", { status: 200, headers: { "content-type": "text/css" } });
        return new Response("x", { status: 404 });
      },
    );
    expect(rec?.url).toBe(
      "https://github.githubassets.com/assets/react-core.3792087592bf207a.module.css",
    );
  });

  it("rejects directory paths whose last segment carries no hash or module marker", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    let calls = 0;
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/settings/flat.css",
      "style",
      new Headers(),
      async () => {
        calls++;
        return new Response("body", { status: 200, headers: { "content-type": "text/css" } });
      },
    );
    expect(rec).toBeNull();
    expect(calls).toBe(0);
  });

  it("rejects deep paths past the segment cap", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/assets/x.js");
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/a/b/c/d/e.chunk.3792087592bf207a.module.css",
      "style",
      new Headers(),
      async () => new Response("body", { status: 200, headers: { "content-type": "text/css" } }),
    );
    expect(rec).toBeNull();
  });

  it("isRecoverableAssetPath: root-flat always, deeper needs a mint marker", () => {
    expect(isRecoverableAssetPath("/flat.css")).toBe(true);
    expect(isRecoverableAssetPath("/owner/repo/x.3792087592bf207a.module.css")).toBe(true);
    expect(isRecoverableAssetPath("/owner/repo/flat.css")).toBe(false);
    expect(isRecoverableAssetPath("/a/b/c/d/e.module.css")).toBe(false);
    expect(isRecoverableAssetPath("")).toBe(false);
  });

  it("isRecoverableAssetPath accepts a SvelteKit dotted hash (#259)", () => {
    expect(isRecoverableAssetPath("/assets/brave-logo-small.Bdzj7Bzm.svg")).toBe(true);
    expect(isRecoverableAssetPath("/assets/favicon-96x96.whEolsYu.png")).toBe(true);
    expect(isRecoverableAssetPath("/assets/brave-logo-small.svg")).toBe(false);
    expect(isRecoverableAssetPath("/sp/search")).toBe(false);
    expect(isRecoverableAssetPath("/assets/brave-logo-small.Bdzj7Bzm.svg.min.js")).toBe(false);
  });

  it("recovers a runtime-minted two-segment image against an observed base (#259)", async () => {
    recordAssetBase("https://p.example/", "https://cdn.example/immutable/assets/app.css");
    let calls = 0;
    const rec = await recoverFlatAsset(
      "https://p.example/",
      "https://p.example/assets/brave-logo-small.Bdzj7Bzm.svg",
      "image",
      new Headers(),
      async (u: string) => {
        calls++;
        if (u === "https://cdn.example/immutable/assets/brave-logo-small.Bdzj7Bzm.svg")
          return new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
        return new Response("no", { status: 404 });
      },
    );
    expect(rec?.url).toBe("https://cdn.example/immutable/assets/brave-logo-small.Bdzj7Bzm.svg");
    expect(calls).toBe(1);
  });

  it("assetBaseCount reports the observed bases for the initiator origin", () => {
    expect(assetBaseCount("https://github.com/")).toBe(0);
    recordAssetBase("https://github.com/", "https://github.githubassets.com/assets/app.js");
    expect(assetBaseCount("https://github.com/")).toBe(1);
    expect(assetBaseCount("")).toBe(0);
  });
});
