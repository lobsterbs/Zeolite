//! #615: CSP translation and directive parsing in Rust.
//!
//! Ports the pure CSP layers of csp-translation.ts (the #452/#527
//! deny-only browser-visible planner) and csp-enforce.ts (the #527
//! engine-side source-list planner, CSP3 host-source matching and
//! the fetch-seam gate decision) into typed structures:
//! SourceExpression, TranslationDecision and EnginePlan. Semantics
//! match the TS implementation exactly; tests/torture.rs is ported
//! row for row from the vitest corpus, and the corpus IS the spec:
//! any diff against the TS oracle is a bug in this port, never a
//! behavior change.
//!
//! The unsafe upstream-'self' to engine-'self' widening is
//! unrepresentable by construction: 'self' resolves only against
//! EnginePlan::self_origin, whose only producer is plan_engine, and
//! plan_engine derives it from the document URL alone. No function
//! in this crate accepts an origin override, so an engine-origin
//! 'self' cannot be minted without forging a plan by hand. Every
//! decision carries its visible x-zl-csp marker row
//! (TranslationDecision::marker, engine_marker).
//!
//! Stays TS-side (#615 scope): header application
//! (applyExperimentalCsp), the memory-only per-client registry and
//! its lifecycle, and the fetch handler wiring. This crate is the
//! pure decision layer those seams call.

pub mod gate;
pub mod plan;
pub mod source;
pub mod translate;
pub mod url;

pub const MAX_POLICY_BYTES: usize = 8192;
pub const MAX_DIRECTIVES: usize = 64;
pub const MAX_SOURCES: usize = 64;

pub use gate::{dest_directive, gate_decision, GateDecision};
pub use plan::{engine_marker, plan_engine, source_matches, EnginePlan};
pub use source::{parse_source_list, parse_token, SourceExpression, TokenVerdict};
pub use translate::{plan_headers, plan_translation, TranslationDecision, UnsupportedReason};
pub use url::Url;
