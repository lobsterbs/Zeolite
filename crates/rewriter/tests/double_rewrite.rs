//! #431 repro: "Me.htm fetched and rewritten twice, then blank". Any
//! path that feeds an ALREADY-REWRITTEN document back through the HTML
//! rewriter (a second pass over composed output, a retried stream, a
//! double fetch) must be a fixpoint: the second pass may not re-wrap
//! engine routes (the double-wrap loop, #1 finding 4) and may not
//! inject a second bootstrap script (double boot breaks the SPA - the
//! white page).

use zeolite_rewriter::config::RewriteConfig;
use zeolite_rewriter::encode::Codec;
use zeolite_rewriter::rewrite_html;

fn cfg() -> RewriteConfig {
    RewriteConfig {
        origin: "https://engine.example".to_string(),
        codec: Codec::Base64Url { prefix: "/zl/".into() },
        inject_bootstrap: true,
        bootstrap_path: "/bootstrap.js".to_string(),
        ..Default::default()
    }
}

/* A ConvergedLogin/Me.htm-shaped document: absolute links to the login
   hosts, a form POSTing to the ESTS endpoint, a loader script, an
   inline script with a URL literal, and an image. */
const ME_HTM: &str = r##"<!DOCTYPE html>
<html><head>
<title>Sign in to your account</title>
<link rel="stylesheet" href="https://login.live.com/converged.v2.login.css">
<script src="https://login.microsoftonline.com/ConvergedLogin_PCore.js"></script>
</head><body>
<form method="post" action="https://login.live.com/oauth20_authorize.srf">
<input name="login" value="">
</form>
<a href="https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20">re-auth</a>
<script>var u = "https://login.live.com/Me.htm?v=3"; fetch(u);</script>
<img src="https://logincdn.msauth.net/logo.png">
</body></html>"##;

/** Every /zl/<token> occurrence in the document. */
fn routes(doc: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = doc;
    while let Some(i) = rest.find("/zl/") {
        let tail = &rest[i + 4..];
        let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(tail.len());
        out.push(format!("/zl/{}", &tail[..end]));
        rest = &tail[end..];
    }
    out
}

#[test]
fn second_pass_is_a_fixpoint() {
    let c = cfg();
    let once = rewrite_html(ME_HTM, &c);
    let twice = rewrite_html(&once, &c);
    assert_eq!(once, twice, "rewriting a rewritten document must be idempotent");
}

#[test]
fn bootstrap_injected_exactly_once_across_two_passes() {
    let c = cfg();
    let once = rewrite_html(ME_HTM, &c);
    let twice = rewrite_html(&once, &c);
    assert_eq!(once.matches("bootstrap.js").count(), 1, "first pass: one bootstrap");
    assert_eq!(twice.matches("bootstrap.js").count(), 1, "second pass must not inject another bootstrap: {twice}");
}

/* Production runs the keyed codec when the SW holds a route key: the
   same fixpoint must hold there (split script routes carry the visible
   path, so the second pass exercises the split-form unwrap too). */
fn keyed_cfg() -> RewriteConfig {
    let key: [u8; 16] = core::array::from_fn(|i| i as u8 ^ 0x5a);
    RewriteConfig {
        origin: "https://engine.example".to_string(),
        codec: Codec::Keyed {
            prefix: "/zl/".into(),
            key,
        },
        inject_bootstrap: true,
        bootstrap_path: "/bootstrap.js".to_string(),
        ..Default::default()
    }
}

#[test]
fn second_pass_is_a_fixpoint_keyed_codec() {
    let c = keyed_cfg();
    let once = rewrite_html(ME_HTM, &c);
    let twice = rewrite_html(&once, &c);
    assert_eq!(once, twice, "keyed: rewriting a rewritten document must be idempotent");
    assert_eq!(twice.matches("bootstrap.js").count(), 1, "keyed: one bootstrap, no re-wrap: {twice}");
}

#[test]
fn engine_routes_not_double_wrapped_across_two_passes() {
    let c = cfg();
    let once = rewrite_html(ME_HTM, &c);
    let twice = rewrite_html(&once, &c);
    assert_eq!(routes(&once).len(), routes(&twice).len(), "second pass must not add route layers");
    for route in routes(&twice) {
        let inner = c.unwrap_engine_route(&route).unwrap();
        assert!(
            inner.starts_with("https://"),
            "route {route} unwraps to {inner}, expected a single-wrap destination"
        );
    }
}
