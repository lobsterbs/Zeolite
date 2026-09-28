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

    /// Decode an already-encoded engine route back to its destination:
    /// root-relative ("/zl/<b64>") or engine-origin-absolute forms,
    /// with optional query/fragment tail. None when the URL is not a
    /// decodable route of this codec. The rewrite passes use this to
    /// keep already-routed URLs untouched: re-encoding a route first
    /// resolves it against the TARGET base, binding it to the target
    /// host and nesting one more encoded layer per pass (the
    /// double-wrap loop, issue #1 finding 4).
    pub fn decode_engine_route(&self, url: &str) -> Option<String> {
        let local = if self.origin.is_empty() {
            url
        } else {
            url.strip_prefix(&self.origin).unwrap_or(url)
        };
        let rest = match &self.codec {
            Codec::Base64Url { prefix } => local.strip_prefix(prefix.as_str())?,
            Codec::PathMirror => local.strip_prefix("/m/")?,
        };
        let end = rest.find(['?', '#']).unwrap_or(rest.len());
        let rest = &rest[..end];
        match &self.codec {
            Codec::Base64Url { .. } => {
                let bytes = crate::encode::b64u_decode(rest)?;
                String::from_utf8(bytes).ok()
            }
            Codec::PathMirror => Some(rest.to_string()),
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
    }
}
