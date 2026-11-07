/* #615: the engine-side CSP source-list planner, matcher and
marker, ported from csp-enforce.ts (#527). The upstream policy is
planned against the document's own virtual origin: 'self' is the
document origin, never the engine origin, so no shared-origin
grant is possible. Every degrade is a false allow, never a false
block. */

use crate::source::{parse_source_list, SourceExpression};
use crate::translate::valid_directive_name;
use crate::url::Url;
use crate::{MAX_DIRECTIVES, MAX_POLICY_BYTES, MAX_SOURCES};
use std::collections::{BTreeMap, BTreeSet};

/* The fetch directives the engine can gate; frame-src/worker-src/
object-src belong to the browser-enforced deny-only subset. */
const FETCH_DIRECTIVES: [&str; 6] = [
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "media-src",
    "connect-src",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnginePlan {
    /* The document's virtual origin: the only representable 'self'
    (#615 widening gate, see the lib docs). */
    pub self_origin: String,
    /* Scheme without the colon (the TS plan keeps "https:"). */
    pub page_scheme: String,
    /* Fully evaluable directives, in policy order. */
    pub enforced: Vec<String>,
    /* Directives seen but not enforceable (nonce/hash/strict-dynamic). */
    pub unsupported: Vec<String>,
    pub sources: BTreeMap<String, Vec<SourceExpression>>,
    pub default_src: Option<Vec<SourceExpression>>,
}

impl Default for EnginePlan {
    fn default() -> Self {
        EnginePlan {
            self_origin: String::new(),
            page_scheme: "https".to_string(),
            enforced: Vec::new(),
            unsupported: Vec::new(),
            sources: BTreeMap::new(),
            default_src: None,
        }
    }
}

/* TS measures raw.length (UTF-16 code units) here, unlike the
translator's byte measure; keep both exact. */
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

pub fn plan_engine(raw: &str, doc_url: &str) -> EnginePlan {
    let url = match Url::parse(doc_url) {
        Some(u) if u.is_network() => u,
        _ => return EnginePlan::default(),
    };
    let mut plan = EnginePlan {
        self_origin: url.origin(),
        page_scheme: url.scheme.clone(),
        ..EnginePlan::default()
    };
    if raw.trim().is_empty()
        || raw.bytes().any(|b| b < 0x20 || b == 0x7f || b == b',')
        || utf16_len(raw) > MAX_POLICY_BYTES
    {
        return plan;
    }
    let parts: Vec<&str> = raw.split(';').collect();
    if parts.len() > MAX_DIRECTIVES + 1 {
        return plan;
    }
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for part in parts {
        let directive = part.trim();
        if directive.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = directive.split_whitespace().collect();
        let name = tokens[0].to_ascii_lowercase();
        if !valid_directive_name(&name) || !seen.insert(name.clone()) {
            return EnginePlan {
                self_origin: plan.self_origin.clone(),
                page_scheme: plan.page_scheme.clone(),
                ..EnginePlan::default()
            };
        }
        /* A directive with no source tokens is invalid: the browser
        ignores it, so the engine-side mirror stays unenforced. */
        if tokens.len() < 2 {
            continue;
        }
        if tokens.len() - 1 > MAX_SOURCES {
            continue;
        }
        if !FETCH_DIRECTIVES.contains(&name.as_str()) && name != "default-src" {
            continue;
        }
        match parse_source_list(&tokens[1..]) {
            None => plan.unsupported.push(name),
            Some(list) => {
                if name == "default-src" {
                    plan.default_src = Some(list);
                } else {
                    plan.sources.insert(name.clone(), list);
                    plan.enforced.push(name);
                }
            }
        }
    }
    plan
}

const SCHEME_DEFAULT_PORTS: [(&str, &str); 2] = [("http", "80"), ("https", "443")];

fn default_port(scheme: &str) -> Option<&str> {
    SCHEME_DEFAULT_PORTS
        .iter()
        .find(|(s, _)| *s == scheme)
        .map(|(_, p)| *p)
}

/* CSP3 host-source matching against the decoded upstream URL. */
pub fn source_matches(s: &SourceExpression, url: &Url, plan: &EnginePlan) -> bool {
    match s {
        SourceExpression::SelfKeyword => url.origin() == plan.self_origin,
        SourceExpression::Any => url.is_network(),
        SourceExpression::Scheme { scheme } => url.scheme == *scheme,
        SourceExpression::Host {
            scheme,
            host,
            wildcard,
            port,
            path,
        } => {
            match scheme {
                Some(s) if url.scheme != *s => return false,
                None if url.scheme != plan.page_scheme => return false,
                _ => {}
            }
            let host_ok = if *wildcard {
                url.host.ends_with(&format!(".{host}"))
            } else {
                url.host == *host
            };
            if !host_ok {
                return false;
            }
            match port {
                /* An absent port matches only the scheme's default port. */
                None => {
                    if !url.port.is_empty() {
                        return false;
                    }
                }
                Some(p) if p == "*" => {}
                /* #629: an explicit default port equals the absent port. */
                Some(p) => {
                    let def = default_port(scheme.as_deref().unwrap_or(&plan.page_scheme));
                    let sp: &str = if Some(p.as_str()) == def {
                        ""
                    } else {
                        p.as_str()
                    };
                    if url.port != sp {
                        return false;
                    }
                }
            }
            if let Some(p) = path {
                if p.ends_with('/') {
                    if !url.pathname.starts_with(p.as_str()) {
                        return false;
                    }
                } else if url.pathname != *p {
                    return false;
                }
            }
            true
        }
    }
}

/* The x-zl-csp marker segment for the engine-side plan (#527):
engine-generated whitelisted directive names only, never upstream
source text. default-src surfaces only when the plan really
enforces it as the fallback. */
pub fn engine_marker(plan: &EnginePlan) -> Option<String> {
    let mut enforced = plan.enforced.clone();
    if plan.default_src.is_some() {
        enforced.push("default-src".to_string());
    }
    let mut segs: Vec<String> = Vec::new();
    if !enforced.is_empty() {
        segs.push(format!("engine {}", enforced.join(",")));
    }
    if !plan.unsupported.is_empty() {
        segs.push(format!("engine-unsupported {}", plan.unsupported.join(",")));
    }
    if segs.is_empty() {
        None
    } else {
        Some(segs.join("; "))
    }
}
