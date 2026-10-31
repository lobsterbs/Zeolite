//! JS rewriting entry points.

pub mod antiframe;
pub mod globals;
pub mod literals;
pub mod meta;

pub use antiframe::antiframe;
pub use globals::rewrite_globals;
pub use literals::{has_origin_pinning_regex, rewrite_inline, rewrite_script};
pub use meta::rewrite_import_meta_url;
