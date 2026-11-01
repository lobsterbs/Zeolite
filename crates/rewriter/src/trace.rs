//! #529: opt-in token-level decision tracing.
//!
//! The rewriter makes token-level decisions (route / skip / neutralize /
//! strip) that `docs/tracing.md` historically documented as not surfaced.
//! This module surfaces them, cheaply and safely:
//!
//! - Opt-in per instance: `Rewriter::set_trace(true)` installs an
//!   aggregator; while off, `record()` checks a `None` refcell first
//!   and allocates nothing.
//! - Fixed vocabulary only: keys are `&'static str` pass and decision
//!   labels compiled into the engine. No source text, URL, or host
//!   ever enters the trace, so a trace cannot leak page data.
//! - Aggregated, not per-token: a `BTreeMap` counts (pass, decision)
//!   pairs, so memory is bounded by the vocabulary size, not the
//!   document. This is the difference between tracing and a log firehose.
//! - Deterministic drain: `take_json()` emits sorted keys and resets,
//!   so repeated runs and snapshot tests are stable.

use std::collections::BTreeMap;

/// Aggregated (pass, decision) counters for one rewriter instance.
#[derive(Default)]
pub struct TraceAgg {
    counts: BTreeMap<(&'static str, &'static str), u64>,
}

impl TraceAgg {
    /// Record one decision occurrence under a pass label. Both labels
    /// are compile-time constants; callers cannot inject page data.
    pub fn record(&mut self, pass: &'static str, decision: &'static str) {
        *self.counts.entry((pass, decision)).or_insert(0) += 1;
    }

    /// Drain the aggregated counters as a deterministic JSON array of
    /// `{ "pass": ..., "decision": ..., "n": ... }` objects sorted by
    /// (pass, decision), then reset. `"[]"` when nothing was recorded.
    pub fn take_json(&mut self) -> String {
        if self.counts.is_empty() {
            return "[]".to_string();
        }
        let mut out = String::from("[");
        let mut first = true;
        for ((pass, decision), n) in self.counts.iter() {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str("{\"pass\":\"");
            out.push_str(pass);
            out.push_str("\",\"decision\":\"");
            out.push_str(decision);
            out.push_str("\",\"n\":");
            out.push_str(&n.to_string());
            out.push('}');
        }
        out.push(']');
        self.counts.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_drains_to_empty_array() {
        let mut t = TraceAgg::default();
        assert_eq!(t.take_json(), "[]");
    }

    #[test]
    fn counts_aggregate_and_drain_deterministically() {
        let mut t = TraceAgg::default();
        t.record("html-url", "routed");
        t.record("html-url", "routed");
        t.record("js-literal", "rewritten");
        let json = t.take_json();
        assert_eq!(
            json,
            "[{\"pass\":\"html-url\",\"decision\":\"routed\",\"n\":2},\
              {\"pass\":\"js-literal\",\"decision\":\"rewritten\",\"n\":1}]"
        );
        /* drained */
        assert_eq!(t.take_json(), "[]");
    }

    #[test]
    fn take_json_is_sorted_and_stable() {
        /* insertion order deliberately unsorted */
        let mut t = TraceAgg::default();
        t.record("zz-pass", "b");
        t.record("aa-pass", "z");
        t.record("aa-pass", "a");
        let json = t.take_json();
        let a = json.find("\"pass\":\"aa-pass\"").expect("aa first");
        let z = json.find("\"pass\":\"zz-pass\"").expect("zz present");
        assert!(a < z);
        assert!(json.starts_with('[') && json.ends_with(']'));
    }
}
