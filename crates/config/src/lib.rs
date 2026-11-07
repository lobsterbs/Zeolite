//! #616: KDL config parsing and secret redaction in Rust.
//!
//! Ports the pure config and redaction layers of the engine app
//! into typed structures: kdl.rs is the KDL v2-subset parser
//! (kdl.ts), rules.rs is the typed rules/siteconfig layer
//! (parseRulesKdl in rules.ts, rulesFromNodes in siteconfig.ts)
//! and redact.rs is the single secret-redaction boundary
//! (diag.ts redactSecrets). Semantics match the TS implementations
//! exactly; the test files are ported row for row from the vitest
//! corpus, and the corpus IS the spec: any diff against the TS
//! oracle is a bug in this port, never a behavior change.
//!
//! #616 hardening beyond TS: the parser is bounded
//! (MAX_SOURCE_BYTES, MAX_NODES, MAX_DEPTH) so hostile config
//! input fails with a line number instead of exhausting memory or
//! stack, and the redaction passes are single-pass linear
//! scanners, not backtracking regexes - the ReDoS class is
//! unrepresentable here by construction.
//!
//! Stays TS-side (#616 scope): the fetch/memoize loaders and
//! doctor states, compileRules URL matching (the interception
//! runtime), Ghostery integration, the diagnostic ring buffers
//! and the wasm-bindgen wiring. This crate is the pure data layer.

pub mod kdl;
pub mod redact;
pub mod rules;

pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
pub const MAX_NODES: usize = 4096;
pub const MAX_DEPTH: usize = 64;

pub use kdl::{parse_kdl, KdlNode, KdlValue, ParseError};
pub use redact::redact_secrets;
pub use rules::{
    parse_rules, rules_from_nodes, HostEntry, KdlData, LocationMode, LocationPolicy, ModifyEntry,
    RewriteEntry, RulesData, SiteRule, SiteRules,
};
