import { describe, expect, it, beforeEach } from "vitest";
import { assetBaseCount, isFlagSurgeryPath, isFlatPath, isRecoverableAssetPath, recordAssetBase, recoverFlatAsset, recordScriptUrl, recoverFlagSurgeryScript, resetAssetBases } from "../assetbases";
import { DIAG } from "../diag";

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

  it("cancels a rejected candidate body before trying the next base (#347 class)", async () => {
    recordAssetBase("https://a.example/", "https://cdn2.example/assets/x.js");
    recordAssetBase("https://a.example/", "https://cdn.example/assets/x.js");
    let cancelled = 0;
    const tracked = (ct: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("b"));
            c.close();
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 200, headers: { "content-type": ct } },
      );
    const rec = await recoverFlatAsset(
      "https://a.example/",
      "https://a.example/flat.module.css",
      "style",
      new Headers(),
      async (u: string) => tracked(u.includes("cdn2") ? "text/css" : "text/html"),
    );
    expect(rec?.url).toBe("https://cdn2.example/assets/flat.module.css");
    expect(cancelled).toBe(1);
  });

  it("logs the bail reason for a traced flag-surgery miss (#296 visibility)", async () => {
    const since = DIAG.snapshot(0).lastSeq;
    const rec = await recoverFlagSurgeryScript(
      "https://a.example/",
      "https://a.example/httpd=1/cb=loaded_undefined_1/m=x",
      new Headers(),
      async () => mkResp(200, "text/javascript"),
      "t-fsmiss",
    );
    expect(rec).toBeNull();
    const ev = DIAG.snapshot(since).events.find((e) => (e.message ?? "").includes("flag-surgery script recovery miss"));
    expect(ev?.message).toContain("no recorded script URLs for this origin");
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

describe("flag-surgery script recovery (#296)", () => {
  beforeEach(() => resetAssetBases());

  it("detects flag-surgery paths and rejects ordinary ones", () => {
    expect(isFlagSurgeryPath("/httpd=1/exm=AIvLTe,a/ed=1/cb=loaded_undefined_9/m=xOTwoc")).toBe(true);
    expect(isFlagSurgeryPath("/httpd=1/cb=loaded_undefined_109/m=ipDJ1")).toBe(true);
    expect(isFlagSurgeryPath("/xjs/s/20261015/mm/x.js")).toBe(false);
    expect(isFlagSurgeryPath("/search")).toBe(false);
    expect(isFlagSurgeryPath("/")).toBe(false);
  });

  it("recovers a flag-surgery miss against the truncated xjs base of an observed script", async () => {
    recordScriptUrl(
      "https://www.google.com/search?q=dfgh",
      "https://www.google.com/xjs/s/20261015/mm/httpd=1/exm=AIvLTe/ed=1/cb=loaded_undefined_1/m=xOTwoc?hl=en",
    );
    const seen: string[] = [];
    const fetchUpstream = async (u: string) => {
      seen.push(u);
      return mkResp(200, "application/javascript");
    };
    const rec = await recoverFlagSurgeryScript(
      "https://www.google.com/search?q=dfgh",
      "https://www.google.com/httpd=1/exm=a/ed=1/cb=loaded_undefined_9/m=xOTwoc?hl=en",
      new Headers(),
      fetchUpstream,
    );
    expect(rec?.url).toBe(
      "https://www.google.com/xjs/s/20261015/mm/httpd=1/exm=a/ed=1/cb=loaded_undefined_9/m=xOTwoc?hl=en",
    );
    expect(seen[0]).toBe(rec?.url);
  });

  it("falls back to the directory base with the first path segment stripped", async () => {
    recordScriptUrl(
      "https://www.google.com/sorry/",
      "https://www.google.com/sorry/bg/sorrybg.ABC123.js?hl=en",
    );
    const seen: string[] = [];
    const fetchUpstream = async (u: string) => {
      seen.push(u);
      /* the full observed tail 404s under the bg directory */
      if (u === "https://www.google.com/sorry/bg/sorry/httpd=1/cb=loaded_undefined_9/m=ipDJ1")
        return mkResp(404, "text/plain");
      return mkResp(200, "text/javascript");
    };
    const rec = await recoverFlagSurgeryScript(
      "https://www.google.com/sorry/",
      "https://www.google.com/sorry/httpd=1/cb=loaded_undefined_9/m=ipDJ1",
      new Headers(),
      fetchUpstream,
    );
    expect(rec?.url).toBe("https://www.google.com/sorry/bg/httpd=1/cb=loaded_undefined_9/m=ipDJ1");
    expect(seen).toEqual([
      "https://www.google.com/sorry/bg/sorry/httpd=1/cb=loaded_undefined_9/m=ipDJ1",
      "https://www.google.com/sorry/bg/httpd=1/cb=loaded_undefined_9/m=ipDJ1",
    ]);
  });

  it("refuses non-flag paths and HTML answers, and the reset seam clears the registry", async () => {
    const boom = async () => {
      throw new Error("must not fetch");
    };
    recordScriptUrl("https://www.google.com/search?q=dfgh", "https://www.google.com/xjs/s/20261015/mm/x.js");
    /* an ordinary script 404 is NOT the flag-surgery class: no retry */
    expect(
      await recoverFlagSurgeryScript(
        "https://www.google.com/search?q=dfgh",
        "https://www.google.com/xjs/s/20261015/mm/app.js",
        new Headers(),
        boom,
      ),
    ).toBeNull();
    /* an origin that never served a script has no bases to try */
    expect(
      await recoverFlagSurgeryScript(
        "https://other.example/",
        "https://other.example/httpd=1/cb=x/m=y",
        new Headers(),
        boom,
      ),
    ).toBeNull();
    /* a 200 HTML answer is a soft-404 shape, not a recovered script */
    expect(
      await recoverFlagSurgeryScript(
        "https://www.google.com/search?q=dfgh",
        "https://www.google.com/httpd=1/cb=loaded_undefined_9/m=xOTwoc",
        new Headers(),
        async () => mkResp(200, "text/html"),
      ),
    ).toBeNull();
    /* the reset seam clears the script registry too */
    resetAssetBases();
    expect(
      await recoverFlagSurgeryScript(
        "https://www.google.com/search?q=dfgh",
        "https://www.google.com/httpd=1/cb=loaded_undefined_9/m=xOTwoc",
        new Headers(),
        boom,
      ),
    ).toBeNull();
  });
});

describe("script URL registry keeps the hottest origin under churn (#358)", () => {
  beforeEach(() => resetAssetBases());

  it("a re-touched origin survives the next eviction, a cold one goes first", async () => {
    const jsUrl = "https://a.example/x/httpd=1/cb=1/m=x.js";
    recordScriptUrl("https://a.example/p", jsUrl);
    for (let i = 0; i < 63; i++) recordScriptUrl(`https://o${i}.example/`, "https://o.example/x.js");
    /* re-touch the hot origin: its recency must refresh (delete-then-set) */
    recordScriptUrl("https://a.example/p", jsUrl);
    /* one more origin trips the cap: the cold o0 must be evicted, not a.example */
    recordScriptUrl("https://new.example/", "https://new.example/y.js");
    const rec = await recoverFlagSurgeryScript(
      "https://a.example/p",
      "https://a.example/httpd=1/cb=1/m=x.js",
      new Headers(),
      async () => mkResp(200, "application/javascript"),
    );
    expect(rec?.url).toBe("https://a.example/x/httpd=1/cb=1/m=x.js");
  });
});

