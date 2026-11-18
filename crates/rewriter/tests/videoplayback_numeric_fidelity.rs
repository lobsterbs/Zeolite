//! #647 controlled A/B fixture: does a Zeolite rewrite pass corrupt the
//! numeric fields (expire/mt/lmt/dur/itag) of googlevideo videoplayback
//! URLs inside a YouTube player response?
//!
//! The fixture below mirrors the reported shape byte-for-byte: YouTube
//! embeds streamingData URLs in ytInitialPlayerResponse with `\/`-escaped
//! slashes and `\u003d`-escaped `=`, carrying the anomalous values from
//! the report (expire=8784516783 == mt, lmt=2944452072092938,
//! dur=72844043 with no decimal point, year 2248).
//!
//! The test runs the fixture through the REAL rewriter pipeline (the same
//! `Rewriter::rewrite_js_body` the wasm JsRewriter drives, plus the
//! streaming HTML pass over a watch-page document) and diffs every numeric
//! field byte-wise: each digit run of >= 4 digits in the input must appear
//! verbatim in the output (either the literal is skipped whole, or the
//! keyed split route keeps path+query verbatim and only the origin becomes
//! a MAC token). A corruption would show up as a missing digit run.
//!
//! Verdict pinned here: the rewriter never alters digits; the anomalous
//! values in the field were minted YouTube-side (decoy streaming data for
//! unattested clients), not produced by an engine pass.

use zeolite_rewriter::{decode_path, Codec, RewriteConfig, Rewriter};

/// The reported anomalous URL, escaped exactly as YouTube spells it inside
/// ytInitialPlayerResponse (`=` -> `\u003d`, `/` -> `\/`).
const ANOMALOUS_ESCAPED: &str = r"https:\/\/rr2---sn-q4flrner.googlevideo.com\/videoplayback?expire\u003d8784516783&mt\u003d8784516783&lmt\u003d2944452072092938&dur\u003d72844043&itag=18&ip=46.57.69.50";

/// A genuine URL from the same session class (`\/`-only escapes, sane
/// numerics: expire = fetch+21599, dur with a decimal point).
const GENUINE_ESCAPED: &str = r"https:\/\/rr1---sn-q4flrnsd.googlevideo.com\/videoplayback?expire=1794452226&mt=1794430686&lmt=1794355401938478&dur=220.000&itag=18";

/// Plain unescaped literal (the shape a non-JSON script body carries).
const PLAIN_URL: &str =
    "https://rr4---sn-4g5e6nzl.googlevideo.com/videoplayback?expire=1794433226&itag=18&dur=220.000";

fn player_js_fixture() -> String {
    format!(
        "var ytInitialPlayerResponse = {{\"streamingData\":{{\"formats\":[{{\"itag\":18,\"url\":\"{ANOMALOUS_ESCAPED}\"}},{{\"itag\":18,\"url\":\"{GENUINE_ESCAPED}\"}}],\"adaptiveFormats\":[]}},\"playabilityStatus\":{{\"status\":\"OK\"}}}};\nfetch(\"{PLAIN_URL}\");\n"
    )
}

fn watch_page_fixture() -> String {
    format!(
        "<!DOCTYPE html><html><head><title>watch</title></head><body><div id=\"player\"></div><script>var ytInitialPlayerResponse = {{\"streamingData\":{{\"formats\":[{{\"itag\":18,\"url\":\"{ANOMALOUS_ESCAPED}\"}}]}},\"playabilityStatus\":{{\"status\":\"OK\"}}}};</script><script src=\"https://www.youtube.com/s/player/abc123/player_ias.vflset/en_US/base.js\"></script></body></html>"
    )
}

fn keyed_cfg() -> RewriteConfig {
    RewriteConfig {
        origin: "https://engine.example".to_string(),
        codec: Codec::Keyed {
            prefix: "/j/".to_string(),
            key: [7u8; 16],
        },
        ..Default::default()
    }
}

/// Every digit run of >= 4 digits in `s` (the numeric fields a URL filter
/// or CDN edge would read).
fn digit_runs(s: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else {
            if cur.len() >= 4 {
                runs.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 4 {
        runs.push(cur);
    }
    runs
}

/// Extract every emitted engine route (`<origin>/j/<tail>`) from a
/// rewritten body, in order.
fn emitted_routes(out: &str, origin: &str) -> Vec<String> {
    let mut routes = Vec::new();
    let mut rest = out;
    while let Some(pos) = rest.find(&format!("{origin}/j/")) {
        let start = pos;
        let after = &rest[start + origin.len() + 3..];
        let end = after
            .find(['"', '\'', '`', ' ', ')', ']'])
            .unwrap_or(after.len());
        routes.push(format!("{origin}/j/{}", &after[..end]));
        rest = &after[end..];
    }
    routes
}

#[test]
fn js_body_pass_preserves_videoplayback_numeric_fields_byte_wise() {
    let fixture = player_js_fixture();
    let cfg = keyed_cfg();
    let mut rw = Rewriter::new(cfg.clone());
    rw.set_base("https://www.youtube.com/watch?v=nYxC9j1Bnrw");
    let out = rw.rewrite_js_body(&fixture);

    // 1. The \u003d-mixed literal is left completely verbatim (json_unescape
    //    refuses literals mixing \/ with other escapes, and the raw probe
    //    does not classify as a URL): every anomalous digit appears
    //    byte-identical, including expire == mt and the pointless dur.
    assert!(
        out.contains(&format!("\"{ANOMALOUS_ESCAPED}\"")),
        "anomalous escaped literal must stay byte-identical, out:\n{out}"
    );
    for needle in [
        r"expire\u003d8784516783",
        r"mt\u003d8784516783",
        r"lmt\u003d2944452072092938",
        r"dur\u003d72844043",
    ] {
        assert!(out.contains(needle), "missing {needle} in:\n{out}");
    }

    // 2. The two routable literals (\/-only escaped and plain) become engine
    //    routes; each route must decode (MAC-verified) back to the EXACT
    //    original URL, digits included. A digit corruption anywhere in the
    //    pass shows up as a decode mismatch or a MAC failure.
    let routes = emitted_routes(&out, "https://engine.example");
    assert_eq!(
        routes.len(),
        2,
        "expected the two routable literals, out:\n{out}"
    );
    let want = [GENUINE_ESCAPED.replace("\\/", "/"), PLAIN_URL.to_string()];
    for (route, original) in routes.iter().zip(want.iter()) {
        let path = route.strip_prefix("https://engine.example").unwrap();
        let decoded = decode_path(&cfg.codec, "https://engine.example", path)
            .expect("keyed route must decode (MAC verified)");
        assert_eq!(
            &decoded, original,
            "route did not round-trip byte-exact (numeric fields altered?)"
        );
        // and the specific numeric fields inside it:
        for run in digit_runs(original) {
            assert!(
                decoded.contains(run.as_str()),
                "digit run {run} altered inside decoded route {decoded}"
            );
        }
    }
}

#[test]
fn html_document_pass_preserves_player_numeric_fields_byte_wise() {
    let fixture = watch_page_fixture();
    let cfg = keyed_cfg();
    let mut rw = Rewriter::new(cfg);
    rw.set_base("https://www.youtube.com/watch?v=nYxC9j1Bnrw");
    let mut out = rw.process(&fixture);
    out.push_str(&rw.finish());

    // The inline ytInitialPlayerResponse script body: the \u003d-mixed
    // literal stays byte-identical inside the document.
    assert!(
        out.contains(ANOMALOUS_ESCAPED),
        "anomalous escaped literal altered inside the document:\n{out}"
    );
    // Every numeric field digit-run survives.
    for run in digit_runs(&fixture) {
        assert!(
            out.contains(run.as_str()),
            "digit run {run} missing/altered in document output:\n{out}"
        );
    }
    // The player base.js script src still routes (origin token, real path
    // visible) - the rewrite is alive, not skipped wholesale.
    assert!(
        out.contains("https://engine.example/j/"),
        "document must still route script srcs:\n{out}"
    );
}

#[test]
fn legacy_base64url_codec_round_trips_the_anomalous_url() {
    // Legacy codec: the whole URL lives inside the b64u tail. Decode must
    // return the exact original - encoding is lossless, digits included.
    let cfg = RewriteConfig {
        origin: "https://engine.example".to_string(),
        codec: Codec::Base64Url {
            prefix: "/j/".to_string(),
        },
        ..Default::default()
    };
    let mut rw = Rewriter::new(cfg.clone());
    rw.set_base("https://www.youtube.com/watch?v=nYxC9j1Bnrw");
    let fixture = format!("fetch(\"{PLAIN_URL}\");");
    let out = rw.rewrite_js_body(&fixture);
    let start = out.find("https://engine.example/j/").expect("route minted");
    let tail_start = start + "https://engine.example/j/".len();
    let tail_end = out[tail_start..]
        .find('"')
        .map(|i| tail_start + i)
        .unwrap_or(out.len());
    let decoded = decode_path(&cfg.codec, "https://engine.example", &out[start..tail_end])
        .expect("legacy tail decodes");
    assert_eq!(decoded, PLAIN_URL, "legacy route must decode byte-exact");
}
