/* #615: row-for-row port of the vitest corpus:
app/src/__tests__/csp-translation.test.ts and the pure layers of
app/src/__tests__/csp-enforce.test.ts. The corpus IS the spec: a
diff against the TS oracle is a bug in this port, never a
behavior change. Not ported: applyExperimentalCsp (header
application stays TS) and the per-client registry lifecycle
(memory-only worker state stays TS); the gate cases drive the
pure decision with a local map instead. */

use std::collections::BTreeMap;

use zeolite_csp::gate::{gate_decision, GateDecision};
use zeolite_csp::plan::{engine_marker, plan_engine, source_matches};
use zeolite_csp::source::SourceExpression;
use zeolite_csp::translate::{
    plan_headers, plan_translation, TranslationDecision, UnsupportedReason,
};
use zeolite_csp::url::Url;
use zeolite_csp::EnginePlan;

const DOC: &str = "https://site.example/page.html";
const SELF: &str = "https://site.example";

fn planned(raw: &str) -> EnginePlan {
    plan_engine(raw, DOC)
}

fn first(policy: &str, directive: &str) -> SourceExpression {
    planned(policy).sources[directive][0].clone()
}

fn u(s: &str) -> Url {
    Url::parse(s).expect("corpus urls are valid")
}

fn cand(policy: &str, directives: &[&str]) -> TranslationDecision {
    TranslationDecision::Candidate {
        policy: policy.to_string(),
        directives: directives.iter().map(|s| s.to_string()).collect(),
    }
}

fn unsupported(reason: UnsupportedReason) -> TranslationDecision {
    TranslationDecision::Unsupported { reason }
}

fn reg(entries: &[(&str, &str)]) -> BTreeMap<String, EnginePlan> {
    let mut m = BTreeMap::new();
    for (client, raw) in entries {
        m.insert((*client).to_string(), planned(raw));
    }
    m
}

fn allow(directive: &str) -> GateDecision {
    GateDecision {
        blocked: false,
        directive: Some(directive.to_string()),
    }
}

fn block(directive: &str) -> GateDecision {
    GateDecision {
        blocked: true,
        directive: Some(directive.to_string()),
    }
}

/* ---- deny-only translation planner (csp-translation.test.ts) ---- */

#[test]
fn constructs_only_deny_only_candidates() {
    assert_eq!(
        plan_translation(
            "object-src 'none'; base-uri 'none'; form-action 'none'",
            false
        ),
        cand(
            "object-src 'none'; base-uri 'none'; form-action 'none'",
            &["object-src", "base-uri", "form-action"],
        )
    );
    assert_eq!(
        plan_translation("OBJECT-SRC 'NONE'", false),
        cand("object-src 'none'", &["object-src"])
    );
    assert!(matches!(
        plan_translation("object-src 'none';", false),
        TranslationDecision::Candidate { .. }
    ));
}

#[test]
fn rejects_virtual_host_unsafe_sources() {
    for policy in [
        "script-src 'self'",
        "script-src https://cdn.example",
        "img-src *",
        "default-src 'none'",
        "object-src 'self'",
        "object-src https://trusted.example",
        "object-src 'none' https://other.example",
        "object-src 'none' 'self'",
        "base-uri 'unsafe-inline'",
        "form-action data:",
        "object-src",
    ] {
        assert!(
            matches!(
                plan_translation(policy, false),
                TranslationDecision::Unsupported { .. }
            ),
            "{policy}"
        );
    }
}

#[test]
fn does_not_drop_sensitive_directives() {
    for policy in [
        "script-src 'nonce-Abc123'",
        "script-src 'sha256-AAAAAAAAAAAA'",
        "script-src 'strict-dynamic' 'nonce-X'",
        "sandbox allow-scripts",
        "upgrade-insecure-requests",
        "connect-src 'none'",
        "frame-ancestors 'none'",
        "report-uri https://report.example/csp",
        "report-to security",
    ] {
        assert!(
            matches!(
                plan_translation(policy, false),
                TranslationDecision::Unsupported { .. }
            ),
            "{policy}"
        );
    }
}

#[test]
fn rejects_duplicates_commas_control_and_bad_names() {
    assert_eq!(
        plan_translation("object-src 'none'; OBJECT-SRC 'none'", false),
        unsupported(UnsupportedReason::DuplicateDirective)
    );
    assert_eq!(
        plan_translation("object-src 'none', base-uri 'none'", false),
        unsupported(UnsupportedReason::InvalidSyntax)
    );
    assert_eq!(
        plan_translation(
            "object-src 'none'\r\nreport-uri https://evil.example",
            false
        ),
        unsupported(UnsupportedReason::InvalidSyntax)
    );
    assert_eq!(
        plan_translation("obj@ct-src 'none'", false),
        unsupported(UnsupportedReason::InvalidSyntax)
    );
    assert_eq!(
        plan_translation(";", false),
        unsupported(UnsupportedReason::InvalidSyntax)
    );
}

#[test]
fn rejects_oversize_without_copying_secrets() {
    assert_eq!(
        plan_translation(&"x".repeat(9000), false),
        unsupported(UnsupportedReason::Oversize)
    );
    let repetitive: Vec<String> = (0..66).map(|i| format!("x{i} 'none'")).collect();
    assert_eq!(
        plan_translation(&repetitive.join(";"), false),
        unsupported(UnsupportedReason::Oversize)
    );
    let report = plan_translation(
        "report-uri https://secret.example/submit?token=hidden",
        false,
    );
    assert!(!format!("{report:?}").contains("hidden"));
}

#[test]
fn never_emits_report_only() {
    assert_eq!(
        plan_translation("object-src 'none'", true),
        unsupported(UnsupportedReason::ReportOnly)
    );
    let (enforcing, report_only) = plan_headers(
        Some("object-src 'none'"),
        Some("script-src https://tracker.example; report-uri /log"),
    );
    assert_eq!(enforcing, Some(cand("object-src 'none'", &["object-src"])));
    assert_eq!(
        report_only,
        Some(unsupported(UnsupportedReason::ReportOnly))
    );
}

#[test]
fn translates_the_audited_worker_frame_child_directives() {
    let all = "object-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none'";
    assert_eq!(
        plan_translation(all, false),
        cand(all, &["object-src", "worker-src", "frame-src", "child-src"])
    );
    for d in ["worker-src", "frame-src", "child-src"] {
        assert!(matches!(
            plan_translation(&format!("{d} 'none'"), false),
            TranslationDecision::Candidate { .. }
        ));
        assert!(matches!(
            plan_translation(&format!("{d} 'self'"), false),
            TranslationDecision::Unsupported { .. }
        ));
        assert!(matches!(
            plan_translation(&format!("{d} https://cdn.example"), false),
            TranslationDecision::Unsupported { .. }
        ));
    }
}

#[test]
fn keeps_audited_unsupported_directives_typed() {
    for d in [
        "frame-ancestors",
        "connect-src",
        "script-src",
        "img-src",
        "sandbox",
        "report-uri",
    ] {
        assert_eq!(
            plan_translation(&format!("{d} 'none'"), false),
            unsupported(UnsupportedReason::UnsupportedDirective)
        );
    }
    assert!(matches!(
        plan_translation("script-src 'nonce-abcd1234'", false),
        TranslationDecision::Unsupported { .. }
    ));
    assert!(matches!(
        plan_translation(
            "script-src 'sha256-4iYvwKpOKvxQNR0lGBTyEK8TqwJcpK46DpKYoLzkX5M'",
            false
        ),
        TranslationDecision::Unsupported { .. }
    ));
}

#[test]
fn marker_rows_name_directives_and_reasons_only() {
    let enforced = plan_translation("frame-src 'none'; object-src 'none'", false);
    assert_eq!(enforced.marker(), "enforced frame-src,object-src");
    let rejected = plan_translation("script-src 'self' https://cdn.example", false);
    assert_eq!(rejected.marker(), "unsupported unsupported-directive");
}

/* ---- engine-side plan, matching, gate (csp-enforce.test.ts) ---- */

#[test]
fn engine_plan_enforces_in_policy_order() {
    let p = planned("script-src https://cdn.example.com; img-src 'self' https://img.example");
    assert_eq!(p.enforced, vec!["script-src", "img-src"]);
    assert!(p.unsupported.is_empty());
    assert_eq!(p.self_origin, SELF);
    assert_eq!(p.page_scheme, "https");
}

#[test]
fn default_src_is_the_fallback_not_enforced() {
    let p = planned("default-src 'self'");
    assert!(p.enforced.is_empty());
    assert_eq!(p.default_src, Some(vec![SourceExpression::SelfKeyword]));
}

#[test]
fn nonce_hash_strict_dynamic_stay_unsupported() {
    let p = planned("script-src 'nonce-abc' 'strict-dynamic' https://cdn.example.com");
    assert!(p.enforced.is_empty());
    assert_eq!(p.unsupported, vec!["script-src"]);
    let h = planned("script-src 'sha256-Q=='; connect-src 'self'");
    assert_eq!(h.enforced, vec!["connect-src"]);
    assert_eq!(h.unsupported, vec!["script-src"]);
}

#[test]
fn ignores_behavioral_keywords_and_non_network_schemes() {
    let p = planned(
        "script-src 'unsafe-inline' 'unsafe-eval' 'report-sample' data: https://cdn.example.com",
    );
    assert_eq!(p.enforced, vec!["script-src"]);
    let i = planned("img-src * data:");
    assert_eq!(i.enforced, vec!["img-src"]);
    assert_eq!(i.sources["img-src"], vec![SourceExpression::Any]);
}

#[test]
fn empty_plans_for_duplicates_commas_control_oversize() {
    assert!(planned("script-src 'self'; script-src 'self'")
        .enforced
        .is_empty());
    assert!(planned("script-src 'self', https://x.example")
        .enforced
        .is_empty());
    assert!(planned("script-src 'self'\u{0}").enforced.is_empty());
    let long = format!("script-src {}", "https://x.example ".repeat(1200));
    assert!(planned(&long).enforced.is_empty());
}

#[test]
fn non_network_or_malformed_doc_yields_empty_plan() {
    let ftp = plan_engine("script-src 'self'", "ftp://x.example/");
    assert!(ftp.enforced.is_empty());
    assert_eq!(ftp.self_origin, "");
    let bad = plan_engine("script-src 'self'", "::::");
    assert!(bad.enforced.is_empty());
    assert_eq!(bad.self_origin, "");
}

#[test]
fn parses_host_source_parts() {
    let p = planned("img-src https://*.example.com:*/lib/");
    assert_eq!(
        p.sources["img-src"],
        vec![SourceExpression::Host {
            scheme: Some("https".into()),
            host: "example.com".into(),
            wildcard: true,
            port: Some("*".into()),
            path: Some("/lib/".into()),
        }]
    );
}

#[test]
fn plain_host_matches_exactly_never_subdomains() {
    let plan = planned("script-src 'self'");
    let src = first("script-src https://cdn.example.com", "script-src");
    assert!(source_matches(
        &src,
        &u("https://cdn.example.com/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &src,
        &u("https://sub.cdN.Example.com/a.js"),
        &plan
    ));
}

#[test]
fn wildcard_host_matches_subdomains_only() {
    let plan = planned("script-src 'self'");
    let src = first("script-src https://*.example.com", "script-src");
    assert!(source_matches(
        &src,
        &u("https://sub.example.com/a.js"),
        &plan
    ));
    assert!(source_matches(
        &src,
        &u("https://a.b.example.com/a.js"),
        &plan
    ));
    assert!(!source_matches(&src, &u("https://example.com/a.js"), &plan));
    assert!(!source_matches(
        &src,
        &u("https://notexample.com/a.js"),
        &plan
    ));
}

#[test]
fn absent_port_matches_only_the_scheme_default() {
    let plan = planned("script-src 'self'");
    let src = first("script-src https://cdn.example.com", "script-src");
    assert!(source_matches(
        &src,
        &u("https://cdn.example.com:443/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &src,
        &u("https://cdn.example.com:8443/a.js"),
        &plan
    ));
    let any = first("script-src https://cdn.example.com:*", "script-src");
    assert!(source_matches(
        &any,
        &u("https://cdn.example.com:8443/a.js"),
        &plan
    ));
}

#[test]
fn explicit_default_port_equals_absent_port() {
    let plan = planned("script-src 'self'");
    let src = first("script-src https://cdn.example.com:443", "script-src");
    assert!(source_matches(
        &src,
        &u("https://cdn.example.com/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &src,
        &u("https://cdn.example.com:8443/a.js"),
        &plan
    ));
    let http = first("script-src http://cdn.example.com:80", "script-src");
    assert!(source_matches(
        &http,
        &u("http://cdn.example.com/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &http,
        &u("http://cdn.example.com:8080/a.js"),
        &plan
    ));
    let bare = first("script-src cdn.example.com:443", "script-src");
    assert!(source_matches(
        &bare,
        &u("https://cdn.example.com/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &bare,
        &u("http://cdn.example.com/a.js"),
        &plan
    ));
    let alt = first("script-src https://cdn.example.com:8443", "script-src");
    assert!(source_matches(
        &alt,
        &u("https://cdn.example.com:8443/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &alt,
        &u("https://cdn.example.com/a.js"),
        &plan
    ));
}

#[test]
fn scheme_less_source_matches_the_page_scheme_only() {
    let plan = planned("script-src 'self'");
    let src = first("script-src cdn.example.com", "script-src");
    assert!(source_matches(
        &src,
        &u("https://cdn.example.com/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &src,
        &u("http://cdn.example.com/a.js"),
        &plan
    ));
}

#[test]
fn trailing_slash_is_prefix_no_slash_is_exact() {
    let plan = planned("script-src 'self'");
    let pre = first("script-src https://cdn.example.com/lib/", "script-src");
    assert!(source_matches(
        &pre,
        &u("https://cdn.example.com/lib/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &pre,
        &u("https://cdn.example.com/libx/a.js"),
        &plan
    ));
    let exact = first("script-src https://cdn.example.com/app.js", "script-src");
    assert!(source_matches(
        &exact,
        &u("https://cdn.example.com/app.js"),
        &plan
    ));
    assert!(source_matches(
        &exact,
        &u("https://cdn.example.com/app.js?x=1"),
        &plan
    ));
    assert!(!source_matches(
        &exact,
        &u("https://cdn.example.com/app.jsx"),
        &plan
    ));
}

#[test]
fn self_matches_the_document_origin_exactly() {
    let plan = planned("script-src 'self'");
    let src = plan.sources["script-src"][0].clone();
    assert!(source_matches(
        &src,
        &u("https://site.example/lib/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &src,
        &u("https://other.example/lib/a.js"),
        &plan
    ));
    assert!(!source_matches(
        &src,
        &u("https://site.example:8443/lib/a.js"),
        &plan
    ));
}

#[test]
fn gate_blocks_outside_the_list_and_allows_inside() {
    let m = reg(&[("c1", "script-src 'self'")]);
    assert_eq!(
        gate_decision(m.get("c1"), "script", "https://site.example/a.js"),
        allow("script-src")
    );
    assert_eq!(
        gate_decision(m.get("c1"), "script", "https://evil.example/a.js"),
        block("script-src")
    );
}

#[test]
fn gate_falls_back_to_default_src() {
    let m = reg(&[("c1", "default-src 'self'")]);
    assert!(gate_decision(m.get("c1"), "image", "https://evil.example/a.png").blocked);
    assert!(!gate_decision(m.get("c1"), "image", "https://site.example/a.png").blocked);
    assert_eq!(
        gate_decision(m.get("c1"), "font", "https://evil.example/a.woff").directive,
        Some("default-src".to_string())
    );
}

#[test]
fn unverifiable_directive_stays_false_allow_others_gate() {
    let m = reg(&[("c1", "script-src 'nonce-x'; img-src 'self'")]);
    assert!(!gate_decision(m.get("c1"), "script", "https://evil.example/a.js").blocked);
    assert!(gate_decision(m.get("c1"), "image", "https://evil.example/a.png").blocked);
}

#[test]
fn gate_maps_destinations() {
    let m = reg(&[(
        "c1",
        "style-src 'self'; media-src 'self'; connect-src 'self'; font-src 'self'",
    )]);
    assert_eq!(
        gate_decision(m.get("c1"), "style", "https://evil.example/a.css").directive,
        Some("style-src".to_string())
    );
    assert_eq!(
        gate_decision(m.get("c1"), "audio", "https://evil.example/a.mp3").directive,
        Some("media-src".to_string())
    );
    assert!(gate_decision(m.get("c1"), "video", "https://evil.example/a.mp4").blocked);
    assert_eq!(
        gate_decision(m.get("c1"), "empty", "https://evil.example/api").directive,
        Some("connect-src".to_string())
    );
    assert_eq!(
        gate_decision(m.get("c1"), "font", "https://evil.example/a.woff").directive,
        Some("font-src".to_string())
    );
    /* Ungated classes: navigations, workers, manifests, objects. */
    assert!(!gate_decision(m.get("c1"), "document", "https://evil.example/").blocked);
    assert!(!gate_decision(m.get("c1"), "worker", "https://evil.example/w.js").blocked);
    assert!(!gate_decision(m.get("c1"), "iframe", "https://evil.example/").blocked);
}

#[test]
fn client_plans_are_isolated_and_clearable() {
    let mut m = reg(&[
        ("c1", "script-src 'self'"),
        ("c2", "script-src https://evil.example"),
    ]);
    assert!(gate_decision(m.get("c1"), "script", "https://evil.example/a.js").blocked);
    assert!(!gate_decision(m.get("c2"), "script", "https://evil.example/a.js").blocked);
    assert!(!gate_decision(m.get("c3"), "script", "https://evil.example/a.js").blocked);
    m.remove("c2");
    assert!(!gate_decision(m.get("c2"), "script", "https://evil.example/a.js").blocked);
}

#[test]
fn non_http_targets_and_unknown_clients_never_block() {
    let m = reg(&[("c1", "script-src 'self'")]);
    assert!(!gate_decision(m.get("c1"), "script", "data:text/plain,x").blocked);
    assert_eq!(
        gate_decision(None, "script", "https://evil.example/a.js"),
        GateDecision {
            blocked: false,
            directive: None,
        }
    );
    assert!(!gate_decision(m.get("c1"), "script", "::::").blocked);
}

#[test]
fn marker_carries_whitelisted_names_only() {
    let p = planned("script-src 'nonce-secretvalue' https://cdn.example.com; img-src 'self'");
    assert_eq!(
        engine_marker(&p).as_deref(),
        Some("engine img-src; engine-unsupported script-src")
    );
    assert_eq!(engine_marker(&planned("upgrade-insecure-requests")), None);
    assert_eq!(
        engine_marker(&planned("default-src 'self'")).as_deref(),
        Some("engine default-src")
    );
    assert_eq!(
        engine_marker(&planned("script-src 'self'; default-src 'self'")).as_deref(),
        Some("engine script-src,default-src")
    );
}
