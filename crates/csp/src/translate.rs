/* #615: the browser-visible deny-only CSP translation planner,
ported from csp-translation.ts (#452/#527). It accepts only the
audited deny-only source-list directives with 'none' as the whole
source list; every rejection is typed, and no upstream source
text is ever copied into an outcome. */

use crate::{MAX_DIRECTIVES, MAX_POLICY_BYTES};
use std::collections::BTreeSet;

const DENY_ONLY: [&str; 6] = [
    "object-src",
    "base-uri",
    "form-action",
    "worker-src",
    "frame-src",
    "child-src",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsupportedReason {
    Oversize,
    InvalidSyntax,
    DuplicateDirective,
    UnsupportedDirective,
    UnsupportedSource,
    ReportOnly,
}

impl UnsupportedReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Oversize => "oversize",
            Self::InvalidSyntax => "invalid-syntax",
            Self::DuplicateDirective => "duplicate-directive",
            Self::UnsupportedDirective => "unsupported-directive",
            Self::UnsupportedSource => "unsupported-source",
            Self::ReportOnly => "report-only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslationDecision {
    Candidate {
        policy: String,
        directives: Vec<String>,
    },
    Unsupported {
        reason: UnsupportedReason,
    },
}

impl TranslationDecision {
    /* The visible x-zl-csp marker row (#527): engine-generated
    whitelisted directive names or a reason enum, never upstream
    source text. */
    pub fn marker(&self) -> String {
        match self {
            Self::Candidate { directives, .. } => {
                format!("enforced {}", directives.join(","))
            }
            Self::Unsupported { reason } => format!("unsupported {}", reason.as_str()),
        }
    }
}

pub fn plan_translation(raw: &str, report_only: bool) -> TranslationDecision {
    use TranslationDecision::Unsupported;
    if report_only {
        return Unsupported {
            reason: UnsupportedReason::ReportOnly,
        };
    }
    /* Byte length, like the TextEncoder measure in TS. */
    if raw.len() > MAX_POLICY_BYTES {
        return Unsupported {
            reason: UnsupportedReason::Oversize,
        };
    }
    /* Reject commas (multiple header policies) and CRLF instead of
    reinterpreting their intersection as a single weaker policy. */
    if raw.trim().is_empty() || raw.bytes().any(|b| b < 0x20 || b == 0x7f || b == b',') {
        return Unsupported {
            reason: UnsupportedReason::InvalidSyntax,
        };
    }
    let parts: Vec<&str> = raw.split(';').collect();
    if parts.len() > MAX_DIRECTIVES + 1 {
        return Unsupported {
            reason: UnsupportedReason::Oversize,
        };
    }
    let mut seen = BTreeSet::new();
    let mut names: Vec<String> = Vec::new();
    for part in parts {
        let directive = part.trim();
        if directive.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = directive.split_whitespace().collect();
        let name = tokens[0].to_ascii_lowercase();
        if !valid_directive_name(&name) {
            return Unsupported {
                reason: UnsupportedReason::InvalidSyntax,
            };
        }
        if !seen.insert(name.clone()) {
            return Unsupported {
                reason: UnsupportedReason::DuplicateDirective,
            };
        }
        if !DENY_ONLY.contains(&name.as_str()) {
            return Unsupported {
                reason: UnsupportedReason::UnsupportedDirective,
            };
        }
        /* 'none' must be the WHOLE source list: combined with
        another source it is ignored, so accepting a mixture could
        dramatically broaden the policy. */
        if tokens.len() != 2 || !tokens[1].eq_ignore_ascii_case("'none'") {
            return Unsupported {
                reason: UnsupportedReason::UnsupportedSource,
            };
        }
        names.push(name);
    }
    if names.is_empty() {
        return Unsupported {
            reason: UnsupportedReason::InvalidSyntax,
        };
    }
    let policy = names
        .iter()
        .map(|d| format!("{} 'none'", d))
        .collect::<Vec<_>>()
        .join("; ");
    TranslationDecision::Candidate {
        policy,
        directives: names,
    }
}

/* Candidate headers are NOT applied by this crate. This classifies
both enforcement and report-only headers without re-parsing,
the port of planCspHeaders. */
pub fn plan_headers(
    enforcing: Option<&str>,
    report_only: Option<&str>,
) -> (Option<TranslationDecision>, Option<TranslationDecision>) {
    (
        enforcing.map(|raw| plan_translation(raw, false)),
        report_only.map(|raw| plan_translation(raw, true)),
    )
}

pub(crate) fn valid_directive_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}
