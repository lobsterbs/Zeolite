/* #615: the fetch-seam gate decision, the port of cspGate from
csp-enforce.ts (#527). The memory-only per-client registry stays
TS-side; this pure function decides one request against one plan,
in the false-allow direction for every unenforced class. */

use crate::plan::{source_matches, EnginePlan};
use crate::url::Url;

pub fn dest_directive(dest: &str) -> Option<&'static str> {
    match dest {
        "script" => Some("script-src"),
        "style" => Some("style-src"),
        "image" => Some("img-src"),
        "font" => Some("font-src"),
        "media" | "audio" | "video" | "track" => Some("media-src"),
        "empty" => Some("connect-src"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateDecision {
    pub blocked: bool,
    /* The directive that decided the request, for the diagnostic. */
    pub directive: Option<String>,
}

pub fn gate_decision(plan: Option<&EnginePlan>, dest: &str, abs_url: &str) -> GateDecision {
    let allow = GateDecision {
        blocked: false,
        directive: None,
    };
    let directive = match dest_directive(dest) {
        Some(d) => d,
        None => return allow,
    };
    let plan = match plan {
        Some(p) => p,
        None => return allow,
    };
    if plan.sources.is_empty() && plan.default_src.is_none() {
        return allow;
    }
    let url = match Url::parse(abs_url) {
        Some(u) if u.is_network() => u,
        _ => return allow,
    };
    if let Some(explicit) = plan.sources.get(directive) {
        if explicit.iter().any(|s| source_matches(s, &url, plan)) {
            return GateDecision {
                blocked: false,
                directive: Some(directive.to_string()),
            };
        }
        return GateDecision {
            blocked: true,
            directive: Some(directive.to_string()),
        };
    }
    if let Some(fallback) = &plan.default_src {
        if fallback.iter().any(|s| source_matches(s, &url, plan)) {
            return GateDecision {
                blocked: false,
                directive: Some("default-src".to_string()),
            };
        }
        return GateDecision {
            blocked: true,
            directive: Some("default-src".to_string()),
        };
    }
    allow
}
