//! JS rewriting entry points.

pub mod antiframe;
pub mod globals;
pub mod literals;

pub use antiframe::antiframe;
pub use globals::rewrite_globals;
pub use literals::{rewrite_inline, rewrite_script};
