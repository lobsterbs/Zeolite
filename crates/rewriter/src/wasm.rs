//! wasm-bindgen entry for the service worker. Streaming: the SW feeds
//! response body chunks in, gets rewritten chunks out.

use crate::config::RewriteConfig;
use crate::encode::Codec;
use crate::html::Rewriter;
use wasm_bindgen::prelude::*;

/// Route scheme selector: "mirror" emits path-mirror routes (/m/...),
/// anything else base64url under the configured prefix, or the keyed
/// opaque codec when a 16-byte route key is passed (#55). The
/// rewriter must emit routes in the scheme the SW decodes: a mirror
/// deployment that gets b64u routes serves links the SW can never
/// decode (#20), and a keyless SW getting keyed routes serves links
/// it can never decode either (#55).
fn codec_for(prefix: String, scheme: String, key: Option<String>) -> Codec {
    if scheme == "mirror" {
        Codec::PathMirror
    } else if let Some(key) = key.as_deref().and_then(crate::encode::parse_key) {
        Codec::Keyed { prefix, key }
    } else {
        Codec::Base64Url { prefix }
    }
}

#[wasm_bindgen]
pub struct JsRewriter {
    inner: Rewriter,
}

#[wasm_bindgen]
impl JsRewriter {
    /// origin: engine origin, e.g. "https://jet.example.com"
    /// base: the real destination URL of the page being rewritten
    /// prefix: codec path prefix (default "/j/")
    /// scheme: route scheme ("mirror" or the b64u default)
    /// key: base64url 16-byte opaque route key (#55); None = legacy
    #[wasm_bindgen(constructor)]
    pub fn new(
        origin: String,
        base: String,
        prefix: String,
        scheme: String,
        key: Option<String>,
    ) -> JsRewriter {
        let cfg = RewriteConfig {
            origin,
            codec: codec_for(prefix, scheme, key),
            ..Default::default()
        };
        let mut inner = Rewriter::new(cfg);
        inner.set_base(&base);
        Self { inner }
    }

    /// Feed one body chunk, get back everything that can be emitted now.
    pub fn process(&mut self, chunk: String) -> String {
        self.inner.process(&chunk)
    }

    /// End of stream: flush retained bytes.
    pub fn finish(&mut self) -> String {
        self.inner.finish()
    }

    /// Phase 3 injection hooks: add a script path injected into <head>
    /// of this page (per-site, userscript-style).
    pub fn add_injection(&mut self, path: String) {
        self.inner.add_injection(&path);
    }

    /// Phase 3 ad/tracker blocking: hosts whose subresource tags are
    /// dropped at rewrite time.
    // js_name matches the add_injection style (snake_case) on the JS side.
    #[wasm_bindgen(js_name = "set_blocked_hosts")]
    pub fn set_blocked_hosts(&mut self, hosts: Vec<String>) {
        self.inner.set_blocked_hosts(hosts);
    }

    /// Opt-in lazy images (host toggle): inject loading=\"lazy\" on
    /// <img> tags that lack one. See RewriteConfig::lazy_images.
    #[wasm_bindgen(js_name = "set_lazy_images")]
    pub fn set_lazy_images(&mut self) {
        self.inner.set_lazy_images();
    }
}

/// The CSS url() encoder shared by the one-shot pass and the streaming
/// rewriter: engine routes are unwrapped to the innermost destination
/// and re-emitted once, everything else resolves against the stylesheet
/// base and encodes to an engine route (issue #1 finding 4).
fn css_enc(cfg: RewriteConfig, base: String) -> Box<dyn Fn(&str) -> String> {
    Box::new(move |u: &str| -> String {
        if let Some(innermost) = cfg.unwrap_engine_route(u) {
            if innermost.starts_with("http://") || innermost.starts_with("https://") {
                let (bare, frag) = match innermost.split_once('#') {
                    Some((b, f)) => (b.to_string(), format!("#{}", f)),
                    None => (innermost, String::new()),
                };
                let mut out = cfg.encode_url(&bare);
                out.push_str(&frag);
                return out;
            }
        }
        let abs = crate::encode::resolve(u, &base);
        cfg.encode_url(&abs)
    })
}

/// #46: one-shot external script body pass for the SW's
/// script-destination seam: URL-literal rewriting + frame-buster
/// neutralization, the same pipeline inline <script> bodies get.
/// Same encoder semantics (engine routes unwrap to the innermost
/// destination, opaque schemes pass through, fragments re-attach);
/// base is the script's own URL.
#[wasm_bindgen(js_name = "rewriteJsBody")]
pub fn rewrite_js_body_export(
    js: String,
    origin: String,
    base: String,
    prefix: String,
    scheme: String,
    key: Option<String>,
) -> String {
    let cfg = RewriteConfig {
        origin,
        codec: codec_for(prefix, scheme, key),
        ..Default::default()
    };
    let mut r = Rewriter::new(cfg);
    r.set_base(&base);
    r.rewrite_js_body(&js)
}

/// One-shot CSS pass for complete strings (style blocks). Standalone
/// stylesheets use the streaming JsCssRewriter below instead.
#[wasm_bindgen(js_name = "rewriteCss")]
pub fn rewrite_css(
    css: String,
    origin: String,
    base: String,
    prefix: String,
    scheme: String,
    key: Option<String>,
) -> String {
    let cfg = RewriteConfig {
        origin,
        codec: codec_for(prefix, scheme, key),
        ..Default::default()
    };
    let enc = css_enc(cfg, base);
    crate::html::css::rewrite_stylesheet(&css, &*enc)
}

/// Streaming CSS rewriter for standalone stylesheet bodies (2.4
/// Bromide): the SW feeds response chunks in, gets rewritten chunks
/// out. No whole-body buffering, so large CSS does not delay first
/// paint, and no document init is injected (CSS is not a document).
#[wasm_bindgen]
pub struct JsCssRewriter {
    inner: crate::html::css::CssRewriter,
}

#[wasm_bindgen]
impl JsCssRewriter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        origin: String,
        base: String,
        prefix: String,
        scheme: String,
        key: Option<String>,
    ) -> JsCssRewriter {
        let cfg = RewriteConfig {
            origin,
            codec: codec_for(prefix, scheme, key),
            ..Default::default()
        };
        Self {
            inner: crate::html::css::CssRewriter::new(css_enc(cfg, base)),
        }
    }

    /// Feed one body chunk, get back everything that can be emitted now.
    pub fn process(&mut self, chunk: String) -> String {
        self.inner.process(&chunk)
    }

    /// End of stream: flush retained bytes.
    pub fn finish(&mut self) -> String {
        self.inner.finish()
    }
}
