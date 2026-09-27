//! Zeolite rewriter: streaming HTML/CSS/JS-literal URL rewriting.
//!
//! Two faces:
//! - Pure Rust API (`Rewriter` + `rewrite_html`), used by tests and any
//!   future server-side caller.
//! - wasm-bindgen entry (`JsRewriter`), used by the service worker.
//!
//! Design: a hand-rolled incremental tokenizer that rewrites in emit.
//! Nothing is ever buffered as a whole document: `process(chunk)` emits
//! as much rewritten output as it can and retains only the incomplete
//! token tail for the next call.

pub const VERSION: &str = "1.4 Boride";

pub mod config;
pub mod encode;
pub mod html;
pub mod js;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use config::RewriteConfig;
pub use encode::{decode_path, Codec};
pub use html::Rewriter;

/// One-shot convenience (tests, probes).
pub fn rewrite_html(input: &str, cfg: &RewriteConfig) -> String {
    let mut r = Rewriter::new(cfg.clone());
    r.set_base("https://example.com/");
    let mut out = r.process(input);
    out.push_str(&r.finish());
    out
}
