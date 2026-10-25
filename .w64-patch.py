import sys

P = sys.argv[1] if len(sys.argv) > 1 else "/home/sprite/z63/"
if not P.endswith("/"):
    P += "/"

def rd(p):
    with open(P + p, "r", encoding="utf-8") as f:
        return f.read()

def wr(p, s):
    with open(P + p, "w", encoding="utf-8") as f:
        f.write(s)

def rep(path, old, new, n=1):
    s = rd(path)
    c = s.count(old)
    assert c == n, "ANCHOR FAIL %s count=%d expected=%d :: %r" % (path, c, n, old[:100])
    wr(path, s.replace(old, new))
    print("ok", path)

# ---- E1: js/mod.rs re-export -------------------------------------------
rep("crates/rewriter/src/js/mod.rs",
    "pub use literals::{rewrite_inline, rewrite_script};",
    "pub use literals::{has_origin_pinning_regex, rewrite_inline, rewrite_script};")

# ---- E2: literals.rs detector + rewrite_script gate --------------------
rep("crates/rewriter/src/js/literals.rs",
r"""/// Rewrite URL-like string literals in a <script> body.
pub fn rewrite_script(js: &str, enc: &dyn Fn(&str) -> String) -> String {
    rewrite_literals(js, enc, true)
}""",
r"""/// #449: does this script body pin its generated URLs to an origin
/// with an anchored regex (a @BT@/^https?:.../@BT@ literal or a
/// @BT@RegExp("...")@BT@ source beginning @BT@^https?:@BT@ / @BT@^https?:@BS@:@BT@)? Such
/// loaders sanity-validate the URLs they build (gapi's "Bad hint:
/// failed sanity", LobsterBrowse #154): a route token fails the pin
/// and the loader throws before any fetch. The scan is a plain
/// substring match on the raw body - the needles are regex-specific
/// byte sequences, and a false positive only skips the literal pass
/// (the runtime seams still route every request), so the failure
/// direction is safe.
pub fn has_origin_pinning_regex(js: &str) -> bool {
    js.contains("^https?:") || js.contains("^https?@BS@@BS@:")
}

/// Rewrite URL-like string literals in a <script> body.
pub fn rewrite_script(js: &str, enc: &dyn Fn(&str) -> String) -> String {
    // #449: an origin-pinning body keeps its URL literals verbatim:
    // the loader validates the URLs it builds. The callers still run
    // their other passes (frame-buster neutralization, #235 globals)
    // over the body.
    if has_origin_pinning_regex(js) {
        return js.to_string();
    }
    rewrite_literals(js, enc, true)
}""")

# ---- E3/E4/E5: literals.rs tests ---------------------------------------
rep("crates/rewriter/src/js/literals.rs",
r"""    /// #206: postfix ++/-- ends the expression, so the '/' after it""",
r"""    /// #449: a gapi-shaped loader validates the URLs it builds
    /// against an anchored origin-pinning regex. The whole literal
    /// pass must skip that body: with the rewritten output exactly
    /// as authored, the loader's own sanity check passes.
    #[test]
    fn origin_pinned_script_keeps_url_literals_verbatim() {
        let js = r#"var va=/^https?:@BS@/@BS@//;var u="https://a.example.com/x";if(!va.test(u))throw new Error("Bad hint: failed sanity");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js, "pinned body changed at all: {}", out);
        assert!(
            !out.contains("[https://a.example.com"),
            "route token in pinned body: {}",
            out
        );
    }

    /// #449: the trigger fires from a RegExp(...) constructor string
    /// and the escaped-colon spelling; a plain body and an anchored
    /// regex without the s-quantifier (the measured-table control)
    /// stay untouched.
    #[test]
    fn origin_pinning_trigger_forms() {
        assert!(
            has_origin_pinning_regex(r#"new RegExp("^https?:@BS@@BS@/[a-z]+@BS@@BS@.example@BS@@BS@.com")"#),
            "RegExp string form not detected"
        );
        assert!(
            has_origin_pinning_regex(r#"var va=/^https?:@BS@:@BS@/@BS@//;"#),
            "escaped-colon form not detected"
        );
        assert!(
            !has_origin_pinning_regex(r#"var u="https://plain.example.com/x";fetch(u);"#),
            "plain body false positive"
        );
        assert!(
            !has_origin_pinning_regex(r#"var va=new RegExp("^https://apis.google.com/");"#),
            "no-quantifier anchored regex false positive"
        );
    }

    /// #449: the skip is whole-script by design: a pinned body's
    /// ordinary fetch literals stay plaintext too (a per-literal skip
    /// would break comparisons that work today); the runtime seams,
    /// not the literal pass, keep those requests on the engine.
    #[test]
    fn pinned_skip_is_script_level() {
        let js = r#"var va=/^https?:@BS@/@BS@//;fetch("https://other.example.com/b");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js, "ordinary literal rewritten inside a pinned body: {}", out);
    }

    /// #449 acceptance: a script without the pinning regex rewrites
    /// exactly as before.
    #[test]
    fn unpinned_script_rewrites_as_before() {
        let js = r#"var u="https://plain.example.com/x";fetch(u);"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(
            out.contains(r#""[https://plain.example.com/x]""#),
            "plain literal not rewritten: {}",
            out
        );
    }

    /// #206: postfix ++/-- ends the expression, so the '/' after it""")

# ---- E6: wasm.rs export ------------------------------------------------
rep("crates/rewriter/src/wasm.rs",
r"""    r.rewrite_js_body(&js)
}

/// One-shot CSS pass for complete strings (style blocks). Standalone""",
r"""    r.rewrite_js_body(&js)
}

/// #449: does this script body pin its generated URLs with an
/// anchored ^https?: regex? Pinned bodies keep their URL literals
/// verbatim in rewriteJsBody (the loader validates them); the SW
/// records the machine-readable literal-skip reason when this fires.
#[wasm_bindgen(js_name = "hasOriginPinningRegex")]
pub fn has_origin_pinning_regex(js: String) -> bool {
    crate::js::has_origin_pinning_regex(&js)
}

/// One-shot CSS pass for complete strings (style blocks). Standalone""")

# ---- E7: transform.ts interface member ---------------------------------
rep("app/src/transform.ts",
r"""  rewriteJsBody(js: string, origin: string, base: string, prefix: string, scheme: string, key?: string): string;""",
r"""  rewriteJsBody(js: string, origin: string, base: string, prefix: string, scheme: string, key?: string): string;
  /* #449: does this script body pin its generated URLs with an
     anchored ^https?: regex? Pinned bodies skip the URL-literal pass
     inside rewriteJsBody (the loader validates the literals it
     builds); the caller uses this to record the skip. Optional:
     older dist wasm exports nothing. */
  hasOriginPinningRegex?(js: string): boolean;""")

# ---- E8: transform.ts wrapper ------------------------------------------
rep("app/src/transform.ts",
r"""  reportGlobals(mod);
  return out;
}""",
r"""  reportGlobals(mod);
  return out;
}

/* #449: origin-pinning detection for the script-serve seams. A body
   whose generated URLs are validated against an anchored ^https?:
   regex keeps its literals verbatim; the caller records the
   machine-readable skip reason. Never throws: a wasm without the
   export (older dist) or a failing detector reports false and the
   literal pass runs. */
export async function scriptPinsOrigins(js: string): Promise<boolean> {
  const mod = await rewriter();
  if (typeof mod.hasOriginPinningRegex !== "function") return false;
  try {
    return !!mod.hasOriginPinningRegex(js);
  } catch {
    return false;
  }
}""")

# ---- E9: netlog.ts field comment ---------------------------------------
rep("app/src/netlog.ts",
r"""  /** Rewrite applied to this response, when any: "html" | "css". */""",
r"""  /** Rewrite applied to this response, when any: "html" | "css" | "js", or "js-pinned" when the #449 origin-pinning literal skip fired. */""")

# ---- E10: netlog.ts annotate helper ------------------------------------
rep("app/src/netlog.ts",
r"""  if (netLog.length > NET_LIMIT) netLog.shift();
}""",
r"""  if (netLog.length > NET_LIMIT) netLog.shift();
}

/** #449: the URL-literal pass can skip a script body (an anchored
    origin-pinning regex, the gapi-class loader case). The row was
    pushed before the body was read, so the skip re-annotates the
    latest row for this traceId with the machine-readable reason
    ("js-pinned"); a traceId with no row is a no-op. */
export function netLogAnnotateRewrite(traceId: string, reason: string): void {
  for (let i = netLog.length - 1; i >= 0; i--) {
    if (netLog[i].traceId === traceId) {
      netLog[i].rewritten = reason;
      return;
    }
  }
}""")

# ---- E11: request.ts imports --------------------------------------------
rep("app/src/request.ts",
r"""import { cssRewriteStream, isCss, isHtml, isJs, rawFrom, rewriteJsBody, rewriteStream, workerPrelude } from "./transform";""",
r"""import { cssRewriteStream, isCss, isHtml, isJs, rawFrom, rewriteJsBody, rewriteStream, scriptPinsOrigins, workerPrelude } from "./transform";""")
rep("app/src/request.ts",
r"""import { flatRed, netLogPush, type NetDetail } from "./netlog";""",
r"""import { flatRed, netLogAnnotateRewrite, netLogPush, type NetDetail } from "./netlog";""")

# ---- E12: request.ts fresh script-serve path ----------------------------
rep("app/src/request.ts",
r"""let src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, decodeBody(await resp.arrayBuffer(), respCt));""",
r"""let src = rewriteModuleWorkerImports(currentPrefix(), target, self.location.origin, decodeBody(await resp.arrayBuffer(), respCt));
            /* #449: an origin-pinning script body (anchored ^https?:
               regex, the gapi-class loader) keeps its URL literals
               verbatim - the rewriter skips the literal pass inside
               rewriteJsBody; this records the machine-readable skip
               on the request's netLog row, the tracing ring and the
               diag stream. The frame-buster and globals passes still
               run; the runtime seams keep every request on the
               engine. */
            let pinnedScript = false;
            try {
              pinnedScript = await scriptPinsOrigins(src);
            } catch {
              pinnedScript = false;
            }
            if (pinnedScript) {
              netLogAnnotateRewrite(traceId, "js-pinned");
              traceDecision({ subsystem: "rewriter", rule: "origin-pinning", original: target, result: "literal-skip", resource: rtype, traceId });
              DIAG.stage(traceId, "PINNED_SCRIPT", { url: target, message: "literal pass skipped: anchored origin-pinning regex (#449)" });
            }""")

# ---- E13: cache-hit script path ----------------------------------------
rep("app/src/request.ts",
r"""              try {
                src = await rewriteJsBody(src, cacheRewriteBase(hit, target));""",
r"""              /* #449: origin-pinning skip telemetry for the cached
                 copy (the fresh path's twin). */
              let pinnedScript = false;
              try {
                pinnedScript = await scriptPinsOrigins(src);
              } catch {
                pinnedScript = false;
              }
              if (pinnedScript) {
                netLogAnnotateRewrite(traceId, "js-pinned");
                DIAG.stage(traceId, "PINNED_SCRIPT", { url: target, message: "literal pass skipped: anchored origin-pinning regex (#449)" });
              }
              try {
                src = await rewriteJsBody(src, cacheRewriteBase(hit, target));""")

# ---- E14: new vitest file -----------------------------------------------
wr("app/src/__tests__/pinned-script.test.ts",
r"""import { describe, expect, it, vi, beforeEach } from "vitest";

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

const PINNED = "var va=/^https?:@BS@@BS@/x/;";
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
""")

# ---- E15: fixtures.mjs ---------------------------------------------------
rep("suite/e2e/fixtures.mjs",
r"""      } else if (path === "/api/data") {""",
r"""      } else if (path === "/dir/pinned.html") {
        /* #449: a page whose loader script pins its generated URLs
           with an anchored origin regex. */
        send(res, "text/html; charset=utf-8", @BT@<!doctype html><html><head><title>zl pinned</title></head><body><p id="zl-pinned">zl-pinned-page</p><script src="pinned.js"></script></body></html>@BT@);
      } else if (path === "/dir/pinned.js") {
        /* #449: a gapi-shaped origin-pinning loader. The rewriter
           must skip the URL-literal pass for this body (the pin regex
           rejects route tokens, the loader throws "Bad hint" before
           any fetch), while the runtime seams (fetch shim, anchor
           nav guard, window.open guard) keep every destination on
           the engine. The popup stays open: the E2E check inspects
           its URL before closing it. */
        send(res, "text/javascript", [
          @BT@var va=/^https?:@BS@@BS@/@BS@@BS@/[a-z0-9_.-]+(:[0-9]+)?@BS@@BS@/dir@BS@@BS@/[a-z-]+@BS@@BS@.html$/;@BT@,
          @BT@var u="http://127.0.0.1:7101/dir/anchor-pinned.html";@BT@,
          @BT@self.__zlPinned={hint:va.test(u)?"validated":"bad-hint"};@BT@,
          @BT@fetch("http://127.0.0.1:7102/api/data").then(function(r){return r.json()}).then(function(j){self.__zlPinnedFetch=j.zl}).catch(function(e){self.__zlPinnedFetch="err:"+e});@BT@,
          @BT@self.__zlPinnedPopup="unset";@BT@,
          @BT@var w=window.open("http://127.0.0.1:7101/dir/popup-pinned.html");@BT@,
          @BT@if(w){self.__zlPinnedPopup="opened"}else{self.__zlPinnedPopup="null"}@BT@,
          @BT@var a=document.createElement("a");a.id="pa";a.href=u;document.body.appendChild(a);@BT@,
        ].join("@BS@n"));
      } else if (path === "/dir/anchor-pinned.html") {
        send(res, "text/html; charset=utf-8", @BT@<!doctype html><p id="zl-ap">anchor-target</p>@BT@);
      } else if (path === "/dir/popup-pinned.html") {
        send(res, "text/html; charset=utf-8", @BT@<!doctype html><p id="zl-pp">popup-target</p>@BT@);
      } else if (path === "/api/data") {""")

# ---- E16: e2e.mjs check --------------------------------------------------
rep("suite/e2e/e2e.mjs",
r"""  /* ---- report ------------------------------------------------------ */""",
r"""  /* ---- #449: origin-pinning script literal skip --------------------- */

  await check("pinned loader: literal skip, loader validates, nothing escapes the engine (#449)", async () => {
    const { page: pg, frame, rec } = await openProxied(ORIGIN_A + "/dir/pinned.html", "#zl-pinned");
    /* Acceptance 1: the loader's own sanity validation passes only
       when its URL literal survived the body pass verbatim. */
    const pinned = JSON.parse(await evalIn(frame, "pinned loader state", @BT@() => JSON.stringify(self.__zlPinned)@BT@));
    assert(pinned && pinned.hint === "validated", "loader sanity failed (literal rewritten?): " + JSON.stringify(pinned));
    /* Acceptance 2: the plaintext fetch literal rides the engine
       (#34 canary: /api/data sends no CORS headers, so only an
       engine-served body is readable). */
    const fetched = await evalIn(frame, "pinned fetch result", @BT@() => new Promise((res) => { const v = self.__zlPinnedFetch; if (v !== undefined) return res(String(v)); setTimeout(() => res("unset"), 8000); })@BT@);
    assert(fetched === "api", "plaintext fetch did not ride the engine: " + fetched);
    /* Acceptance 2: window.open must stay on the engine - a popup at
       the fixture origin is a direct escape. */
    const pages = pg.context.pages();
    const escaped = pages.filter((p) => p.url().startsWith(ORIGIN_A) || p.url().startsWith(ORIGIN_B));
    assert(escaped.length === 0, "window.open escaped the engine: " + escaped.map((p) => p.url()).join(", "));
    for (const p of pages) if (p !== pg) await p.close().catch(() => {});
    /* Acceptance 2: the JS-written anchor click must navigate through
       the engine, never browser-direct. */
    await frame.locator("#pa").click();
    const navFrame = await waitFor("anchor navigation through the engine", 30000, async () => {
      for (const f of pg.frames()) {
        const u = f.url();
        if (!u.startsWith(ENGINE)) continue;
        try {
          if ((await f.locator("#zl-ap").count()) > 0) return f;
        } catch {}
      }
      return null;
    });
    assert(navFrame && navFrame.url().startsWith(ENGINE), "anchor click escaped the engine: " + (navFrame ? navFrame.url() : "no frame"));
    /* Wire log: every hit on this fixture's unique paths arrived
       engine-referered or refererless; an engine-origin Referer means
       the browser went direct. */
    await new Promise((r2) => setTimeout(r2, 1500));
    const hits = (await fixtureHits(fixtureA)).concat(await fixtureHits(fixtureB));
    const mine = hits.filter((h) => ["/dir/pinned.js", "/dir/pinned.html", "/dir/anchor-pinned.html", "/dir/popup-pinned.html"].includes(h.path));
    assert(mine.some((h) => h.path === "/dir/pinned.js"), "the engine never fetched the pinned script body");
    const bads = mine.filter((h) => String(h.referer ?? "").includes("127.0.0.1:6002") || String(h.referer ?? "").includes("/j/"));
    assert(bads.length === 0, "browser-direct hits on pinned fixture paths: " + JSON.stringify(bads.slice(0, 4)));
    /* CDP: the browser itself never touched a fixture origin. */
    const direct = rec.requests.filter((r3) => r3.url.startsWith(ORIGIN_A) || r3.url.startsWith(ORIGIN_B));
    assert(direct.length === 0, "browser-direct requests to fixture origins: " + JSON.stringify(direct.slice(0, 4).map((r3) => r3.url)));
    return "validated; fetch engine-served; popup engine-routed; anchor engine-routed; wire clean";
  });

  /* ---- report ------------------------------------------------------ */""")

# ---- E17: diag.ts DiagStage gains PINNED_SCRIPT ------------------------
rep("app/src/diag.ts",
    '  | "REDIRECTED";',
    '  | "REDIRECTED"@BS@n  | "PINNED_SCRIPT";')

print("PATCH2 DONE")
