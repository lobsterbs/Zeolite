//! JS rewriting entry points.

pub mod antiframe;
pub mod literals;

pub use antiframe::antiframe;
pub use literals::{rewrite_inline, rewrite_script};
