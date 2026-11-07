//! Hand-rolled JSON emission for the wasm seams: the pure core
//! crates stay serde-free and the lockfile gains nothing. Every
//! emitted shape mirrors the TS structure exactly - optional
//! CspSource fields are ABSENT when None (null would flip the
//! sourceMatches branches, since null !== undefined in JS),
//! empty rules lists are omitted like parseRulesKdl's {} output,
//! and maps keep insertion order, never sorted. Non-finite
//! numbers emit as null: JSON cannot carry Infinity, so a
//! hostile 1e999 arg dies there instead of poisoning the
//! payload (profile validation rejects it either way).

use zeolite_config::{KdlData, LocationMode, RulesData, SiteRule, SiteRules};
use zeolite_csp::{EnginePlan, SourceExpression, TranslationDecision};

/// JSON string literal: quotes, backslash and control escapes;
/// everything else, including UTF-8, passes through raw.
pub(crate) fn jstr(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// JS-Number-shaped output. JSON has no Infinity or NaN: those
/// degrade to null (the honest floor; TS would have carried the
/// value but profile validation rejects non-finite caps anyway).
fn num(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    format!("{n}")
}

fn str_list(items: &[String], out: &mut String) {
    out.push('[');
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        jstr(s, out);
    }
    out.push(']');
}

fn comma(out: &mut String, first: &mut bool) {
    if *first {
        *first = false;
    } else {
        out.push(',');
    }
}

fn types_field(types: &Option<Vec<String>>, out: &mut String) {
    if let Some(t) = types {
        out.push_str(",\"types\":");
        str_list(t, out);
    }
}

/// TranslationDecision as the TS CspTranslationPlan shape.
pub(crate) fn translation(d: &TranslationDecision) -> String {
    let mut out = String::new();
    match d {
        TranslationDecision::Candidate { policy, directives } => {
            out.push_str("{\"kind\":\"candidate\",\"policy\":");
            jstr(policy, &mut out);
            out.push_str(",\"directives\":");
            str_list(directives, &mut out);
            out.push('}');
        }
        TranslationDecision::Unsupported { reason } => {
            out.push_str("{\"kind\":\"unsupported\",\"reason\":");
            jstr(reason.as_str(), &mut out);
            out.push('}');
        }
    }
    out
}

fn source(s: &SourceExpression, out: &mut String) {
    match s {
        SourceExpression::SelfKeyword => out.push_str("{\"k\":\"self\"}"),
        SourceExpression::Any => out.push_str("{\"k\":\"any\"}"),
        SourceExpression::Scheme { scheme } => {
            out.push_str("{\"k\":\"scheme\",\"scheme\":");
            jstr(scheme, out);
            out.push('}');
        }
        SourceExpression::Host {
            scheme,
            host,
            wildcard,
            port,
            path,
        } => {
            out.push_str("{\"k\":\"host\"");
            if let Some(scheme) = scheme {
                out.push_str(",\"scheme\":");
                jstr(scheme, out);
            }
            out.push_str(",\"host\":");
            jstr(host, out);
            // TS checks treat absent and false alike; the explicit
            // boolean keeps the literal TS object shape.
            out.push_str(if *wildcard {
                ",\"wildcard\":true"
            } else {
                ",\"wildcard\":false"
            });
            if let Some(port) = port {
                out.push_str(",\"port\":");
                jstr(port, out);
            }
            if let Some(path) = path {
                out.push_str(",\"path\":");
                jstr(path, out);
            }
            out.push('}');
        }
    }
}

fn sources(list: &[SourceExpression], out: &mut String) {
    out.push('[');
    for (i, s) in list.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        source(s, out);
    }
    out.push(']');
}

/// EnginePlan as the TS CspEnginePlan shape. The Rust page_scheme
/// carries no colon; TS stores u.protocol, which does.
pub(crate) fn engine_plan(p: &EnginePlan) -> String {
    let mut out = String::from("{\"selfOrigin\":");
    jstr(&p.self_origin, &mut out);
    out.push_str(",\"pageScheme\":");
    jstr(&format!("{}:", p.page_scheme), &mut out);
    out.push_str(",\"enforced\":");
    str_list(&p.enforced, &mut out);
    out.push_str(",\"unsupported\":");
    str_list(&p.unsupported, &mut out);
    out.push_str(",\"sources\":{");
    for (i, (name, list)) in p.sources.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        jstr(name, &mut out);
        out.push(':');
        sources(list, &mut out);
    }
    out.push_str("},\"defaultSrc\":");
    match &p.default_src {
        None => out.push_str("null"),
        Some(list) => sources(list, &mut out),
    }
    out.push('}');
    out
}

/// RulesData as the TS RulesData shape: empty lists are omitted,
/// exactly like the TS {} + push-on-demand output.
pub(crate) fn rules_data(d: &RulesData) -> String {
    let mut out = String::from("{");
    let mut first = true;
    if !d.block.is_empty() {
        comma(&mut out, &mut first);
        out.push_str("\"block\":[");
        for (i, e) in d.block.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"host\":");
            jstr(&e.host, &mut out);
            types_field(&e.types, &mut out);
            out.push('}');
        }
        out.push(']');
    }
    if !d.allow.is_empty() {
        comma(&mut out, &mut first);
        out.push_str("\"allow\":[");
        for (i, e) in d.allow.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"host\":");
            jstr(&e.host, &mut out);
            types_field(&e.types, &mut out);
            out.push('}');
        }
        out.push(']');
    }
    if !d.rewrite.is_empty() {
        comma(&mut out, &mut first);
        out.push_str("\"rewrite\":[");
        for (i, e) in d.rewrite.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"from\":");
            jstr(&e.from, &mut out);
            out.push_str(",\"to\":");
            jstr(&e.to, &mut out);
            types_field(&e.types, &mut out);
            out.push('}');
        }
        out.push(']');
    }
    if !d.modify.is_empty() {
        comma(&mut out, &mut first);
        out.push_str("\"modify\":[");
        for (i, e) in d.modify.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"host\":");
            jstr(&e.host, &mut out);
            out.push_str(",\"headers\":{");
            for (h, (k, v)) in e.headers.iter().enumerate() {
                if h > 0 {
                    out.push(',');
                }
                jstr(k, &mut out);
                out.push(':');
                jstr(v, &mut out);
            }
            out.push('}');
            types_field(&e.types, &mut out);
            out.push('}');
        }
        out.push(']');
    }
    out.push('}');
    out
}

fn mode_str(m: &LocationMode) -> &'static str {
    match m {
        LocationMode::Legacy => "legacy",
        LocationMode::Hybrid => "hybrid",
        LocationMode::Off => "off",
    }
}

fn site_rule(rule: &SiteRule, out: &mut String) {
    out.push('{');
    let mut first = true;
    if let Some(lr) = &rule.location_rewrite {
        comma(out, &mut first);
        out.push_str("\"locationRewrite\":{\"mode\":");
        jstr(mode_str(&lr.mode), out);
        out.push_str(&format!(",\"maxBytes\":{}}}", lr.max_bytes));
    }
    if let Some(v) = &rule.inject {
        comma(out, &mut first);
        out.push_str("\"inject\":");
        str_list(v, out);
    }
    if let Some(v) = &rule.block {
        comma(out, &mut first);
        out.push_str("\"block\":");
        str_list(v, out);
    }
    if let Some(v) = &rule.plugins {
        comma(out, &mut first);
        out.push_str("\"plugins\":");
        str_list(v, out);
    }
    if let Some(v) = &rule.fingerprint {
        comma(out, &mut first);
        out.push_str("\"fingerprint\":");
        kdl_data(v, out);
    }
    out.push('}');
}

/// SiteRules as the TS SiteRules shape: only set fields emit, and
/// the fingerprint null-drop already happened in the crate
/// (kdlNodeValue null never assigns), matching rulesFromNodes.
pub(crate) fn site_rules(rules: &SiteRules) -> String {
    let mut out = String::from("{");
    for (i, (host, rule)) in rules.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        jstr(host, &mut out);
        out.push(':');
        site_rule(rule, &mut out);
    }
    out.push('}');
    out
}

fn kdl_data(d: &KdlData, out: &mut String) {
    match d {
        KdlData::Null => out.push_str("null"),
        KdlData::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        KdlData::Num(n) => out.push_str(&num(*n)),
        KdlData::Str(s) => jstr(s, out),
        KdlData::List(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                kdl_data(item, out);
            }
            out.push(']');
        }
        KdlData::Map(entries) => {
            out.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                jstr(k, out);
                out.push(':');
                kdl_data(v, out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::jstr;

    #[test]
    fn escapes_json_specials() {
        let mut out = String::new();
        jstr("a\"b\\c\nd\te\u{1}f\u{e4}g", &mut out);
        assert_eq!(out, "\"a\\\"b\\\\c\\nd\\te\\u0001f\u{e4}g\"");
    }
}
