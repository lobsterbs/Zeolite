//! wasm-bindgen entry for the service worker. Streaming: the SW feeds
//! response body chunks in, gets rewritten chunks out.

use crate::config::RewriteConfig;
use crate::encode::Codec;
use crate::html::Rewriter;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct JsRewriter {
    inner: Rewriter,
}

#[wasm_bindgen]
impl JsRewriter {
    /// origin: engine origin, e.g. "https://jet.example.com"
    /// base: the real destination URL of the page being rewritten
    /// prefix: codec path prefix (default "/j/")
    #[wasm_bindgen(constructor)]
    pub fn new(origin: String, base: String, prefix: String) -> JsRewriter {
        let cfg = RewriteConfig {
            origin,
            codec: Codec::Base64Url { prefix },
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
}

/// One-shot CSS pass for standalone stylesheets: rewrite every url()
/// against the page base. Stylesheets are not first-paint documents, so
/// a single-pass (not incremental) transform is fine here.
#[wasm_bindgen(js_name = "rewriteCss")]
pub fn rewrite_css(css: String, origin: String, base: String, prefix: String) -> String {
    let cfg = RewriteConfig {
        origin,
        codec: Codec::Base64Url { prefix },
        ..Default::default()
    };
    let enc = |u: &str| -> String {
        // Already an engine route: keep as-is. Resolving a route against
        // the CSS base binds it to the target host and re-encodes it one
        // layer deeper per pass (issue #1 finding 4).
        if let Some(dest) = cfg.decode_engine_route(u) {
            if dest.starts_with("http://") || dest.starts_with("https://") {
                return u.to_string();
            }
        }
        let abs = crate::encode::resolve(u, &base);
        cfg.encode_url(&abs)
    };
    crate::html::css::rewrite_stylesheet(&css, &enc)
}
