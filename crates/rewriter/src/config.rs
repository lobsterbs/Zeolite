//! Rewrite configuration: origin, URL codec scheme, feature toggles,
//! per-site injection hooks and ad/tracker host blocking.

use crate::encode::Codec;

/// Per-site overrides discovered by the compat suite. Every compat failure
/// becomes a rule here (or a JSON site config loaded at runtime), never a
/// hardcoded branch inside the rewriter.
#[derive(Debug, Clone)]
pub struct RewriteConfig {
    /// Engine origin, e.g. "https://jet.example.com".
    pub origin: String,
    /// URL codec: destination encoding scheme (path shape can rotate).
    pub codec: Codec,
    /// Rewrite url(...) inside <style> and style="".
    pub rewrite_css: bool,
    /// Rewrite URL string literals inside <script> and event attributes.
    pub rewrite_js_literals: bool,
    /// Inject the runtime bootstrap <script> into <head>.
    pub inject_bootstrap: bool,
    /// Bootstrap asset path on the engine origin.
    pub bootstrap_path: String,
    /// Extra scripts injected right after <head> opens (userscript-style
    /// hooks, per-site; Phase 3 injection hooks API).
    pub injections: Vec<String>,
    /// Strip ad/tracker subresources at the rewrite layer: hosts whose
    /// requests should never leave the browser (Phase 3).
    pub block_hosts: Vec<String>,
}

impl Default for RewriteConfig {
    fn default() -> Self {
        Self {
            origin: String::new(),
            codec: Codec::Base64Url {
                prefix: "/j/".into(),
            },
            rewrite_css: true,
            rewrite_js_literals: true,
            inject_bootstrap: true,
            bootstrap_path: "/bootstrap.js".into(),
            injections: Vec::new(),
            block_hosts: Vec::new(),
        }
    }
}

impl RewriteConfig {
    /// Encode an absolute destination URL into an engine-local URL.
    pub fn encode_url(&self, dest: &str) -> String {
        match &self.codec {
            Codec::Base64Url { prefix } => {
                format!(
                    "{}{}{}",
                    self.origin,
                    prefix,
                    crate::encode::b64u_encode(dest.as_bytes())
                )
            }
            Codec::PathMirror => format!("{}/m/{}", self.origin, dest),
        }
    }

    /// Recognize an already-encoded engine route and return the
    /// INNERMOST destination it encodes, peeling every layer.
    ///
    /// Issue #1 finding 4 (live on google.com): a route can be bound to
    /// the TARGET host (https://target/zl/<b64>) - the browser requests
    /// it cross-origin and the target's 404 page answers - and every
    /// rewrite pass adds one more layer. The loop must be killed for ALL
    /// host bindings, so recognition accepts three forms: engine-origin-
    /// absolute, root-relative, and any-host path-prefixed. Iterative:
    /// a decoded layer that is itself a route is peeled again (bounded).
    /// Never returns None: a URL whose tail does not decode is itself
    /// the final destination and is returned unchanged.
    pub fn unwrap_engine_route(&self, url: &str) -> Option<String> {
        let mut current = url.to_string();
        for _ in 0..8 {
            match self.decode_engine_route(&current) {
                Some(next) if next != current => current = next,
                _ => return Some(current),
            }
        }
        Some(current)
    }

    /// Decode ONE already-encoded engine route layer: root-relative
    /// ("/zl/<b64>"), engine-origin-absolute, or bound to any host
    /// ("https://target/zl/<b64>", the form the double-wrap loop
    /// produces). None when the URL carries no decodable route layer.
    pub fn decode_engine_route(&self, url: &str) -> Option<String> {
        // Engine-origin-absolute routes strip the origin; any-host routes
        // (https://target/zl/<b64>) drop their scheme://host authority
        // and keep the path; root-relative routes are already local.
        // Whatever remains must start with the codec prefix: a
        // coincidental same-named path that does not decode stays a
        // normal URL (None).
        let local = if let Some(stripped) = url.strip_prefix(&self.origin) {
            stripped
        } else if let Some(i) = url.find("://") {
            let rest = &url[i + 3..];
            let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            url.get(i + 3 + end..)?
        } else {
            url
        };
        let rest = match &self.codec {
            Codec::Base64Url { prefix } => local.strip_prefix(prefix.as_str())?,
            Codec::PathMirror => local.strip_prefix("/m/")?,
        };
        // Mirror tails carry the destination verbatim, query included:
        // only a fragment ends that payload. b64u tails stop at the
        // first '?' or '#' (issue #20).
        match &self.codec {
            Codec::Base64Url { .. } => {
                let end = rest.find(['?', '#']).unwrap_or(rest.len());
                let bytes = crate::encode::b64u_decode(&rest[..end])?;
                String::from_utf8(bytes).ok()
            }
            Codec::PathMirror => {
                let end = rest.find('#').unwrap_or(rest.len());
                Some(rest[..end].to_string())
            }
        }
    }

    /// True when the host of `url` matches a block_hosts entry (exact or
    /// parent-domain suffix). Blocking happens at rewrite time: the
    /// tag never reaches the DOM, so no request is ever issued.
    pub fn is_blocked(&self, url: &str) -> bool {
        let Some(host) = crate::encode::url_host(url) else {
            return false;
        };
        let host = host.to_ascii_lowercase();
        self.block_hosts.iter().any(|b| {
            let b = b.to_ascii_lowercase();
            host == b || host.ends_with(&format!(".{}", b))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_routes_decode_for_the_rewrap_guard() {
        let c = RewriteConfig {
            origin: "https://proxy.example".into(),
            codec: Codec::Base64Url {
                prefix: "/zl/".into(),
            },
            ..Default::default()
        };
        let dest = "https://chatgpt.com/x?y=1";
        let route = format!("/zl/{}", crate::encode::b64u_encode(dest.as_bytes()));
        // Root-relative and fragment-carrying forms decode.
        assert_eq!(c.decode_engine_route(&route).as_deref(), Some(dest));
        let frag = format!("{}#frag", route);
        assert_eq!(c.decode_engine_route(&frag).as_deref(), Some(dest));
        // Engine-origin-absolute form decodes.
        let abs = format!("https://proxy.example{}", route);
        assert_eq!(c.decode_engine_route(&abs).as_deref(), Some(dest));
        // Other paths are not routes.
        assert_eq!(c.decode_engine_route("/other"), None);
        // Target-host-bound form (the loop's output shape) decodes.
        let bound = format!("https://chatgpt.com{}", route);
        assert_eq!(c.decode_engine_route(&bound).as_deref(), Some(dest));
        // Iterative unwrap peels every layer down to the innermost
        // destination, whatever host each layer is bound to.
        let dest2 = "https://www.google.com/search?q=hi";
        let route2 = format!("/zl/{}", crate::encode::b64u_encode(dest2.as_bytes()));
        let bound2 = format!("https://www.google.com{}", route2);
        let nested = format!("/zl/{}", crate::encode::b64u_encode(bound2.as_bytes()));
        assert_eq!(c.unwrap_engine_route(&nested).as_deref(), Some(dest2));
    }

    /// Issue #20: mirror tails are the destination verbatim, so the
    /// query is payload (only a fragment ends it), unlike b64u tails.
    #[test]
    fn mirror_scheme_routes_decode_for_the_rewrap_guard() {
        let c = RewriteConfig {
            origin: "https://proxy.example".into(),
            codec: Codec::PathMirror,
            ..Default::default()
        };
        let route = c.encode_url("https://a.dev/p?q=1");
        assert_eq!(route, "https://proxy.example/m/https://a.dev/p?q=1");
        assert_eq!(c.decode_engine_route(&route).as_deref(), Some("https://a.dev/p?q=1"));
        let frag = format!("{}#f", route);
        assert_eq!(c.decode_engine_route(&frag).as_deref(), Some("https://a.dev/p?q=1"));
        assert_eq!(
            c.decode_engine_route("/m/https://a.dev/p?q=1").as_deref(),
            Some("https://a.dev/p?q=1")
        );
        assert_eq!(
            c.decode_engine_route("https://b.dev/m/https://a.dev/p?q=1").as_deref(),
            Some("https://a.dev/p?q=1")
        );
        let bound = "https://b.dev/m/https://a.dev/p?q=1";
        let nested = c.encode_url(bound);
        assert_eq!(c.unwrap_engine_route(&nested).as_deref(), Some("https://a.dev/p?q=1"));
        assert_eq!(c.decode_engine_route("/other"), None);
    }
}
