//! #614/#615/#616 wiring: the wasm-bindgen seam over the pure
//! Rust ports (zeolite-csp, zeolite-config). Every export is a
//! pure string-in/JSON-out function whose output matches the TS
//! structure it replaces, so the TS callers can use either
//! implementation: they keep their own bodies as the fail-safe
//! fallback (app/src/seam.ts), and when the module is missing,
//! older, or its init failed, the engine runs exactly as it does
//! today. wasm-pack builds it as seam_wasm.js / seam_wasm_bg.wasm;
//! CI ships both next to the service worker (sibling assets, the
//! rewriter_wasm precedent).
//!
//! Cookies (#614) stay TS-side in this crate: the jar is a
//! stateful multi-profile orchestration, not a pure seam, and its
//! wiring phase stays tracked on the issue.
//!
//! Documented divergence beyond TS, inherited from the crates: a
//! config over 1 MiB / 4096 nodes / depth 64 fails here in
//! bounded time where TS would parse slowly (the #616 hardening);
//! shipped configs are far under the caps, and the failure lands
//! in the loaders' existing "invalid" doctor state.

mod json;

use wasm_bindgen::prelude::*;

use zeolite_config::{parse_kdl, parse_rules, redact_secrets, rules_from_nodes};
use zeolite_csp::{plan_engine, plan_translation};

/// CSP translation planner (csp-translation.ts planCspTranslation):
/// returns the CspTranslationPlan JSON.
#[wasm_bindgen(js_name = "planTranslation")]
pub fn plan_translation_js(raw: &str, report_only: bool) -> String {
    json::translation(&plan_translation(raw, report_only))
}

/// CSP engine planner (csp-enforce.ts planEngineCsp): returns the
/// CspEnginePlan JSON. The registry, gate and fetch wiring stay
/// TS-side (#615 scope).
#[wasm_bindgen(js_name = "planEngineCsp")]
pub fn plan_engine_js(raw: &str, doc_url: &str) -> String {
    json::engine_plan(&plan_engine(raw, doc_url))
}

/// rules.kdl body to RulesData JSON; None when the KDL parse
/// fails, which the loader maps to its existing "invalid" doctor
/// state, exactly like the TS parseKdl throw.
#[wasm_bindgen(js_name = "parseRulesKdl")]
pub fn parse_rules_js(body: &str) -> Option<String> {
    let doc = parse_kdl(body).ok()?;
    Some(json::rules_data(&parse_rules(&doc)))
}

/// siteconfig.kdl body to SiteRules JSON; None on parse failure.
#[wasm_bindgen(js_name = "parseSiteconfigKdl")]
pub fn parse_siteconfig_js(body: &str) -> Option<String> {
    let doc = parse_kdl(body).ok()?;
    Some(json::site_rules(&rules_from_nodes(&doc)))
}

/// diag.ts redactSecrets: the single secret-redaction boundary.
#[wasm_bindgen(js_name = "redactSecrets")]
pub fn redact_secrets_js(s: &str) -> String {
    redact_secrets(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_unsupported_exact() {
        assert_eq!(
            plan_translation_js("img-src a.com", true),
            "{\"kind\":\"unsupported\",\"reason\":\"report-only\"}"
        );
        assert_eq!(
            plan_translation_js(&"a".repeat(zeolite_csp::MAX_POLICY_BYTES + 1), false),
            "{\"kind\":\"unsupported\",\"reason\":\"oversize\"}"
        );
        assert_eq!(
            plan_translation_js("img-src a.com,b", false),
            "{\"kind\":\"unsupported\",\"reason\":\"invalid-syntax\"}"
        );
    }

    #[test]
    fn engine_plan_exact() {
        let j = plan_engine_js("img-src a.com", "https://x.test:8443/");
        assert_eq!(
            j,
            "{\"selfOrigin\":\"https://x.test:8443\",\"pageScheme\":\"https:\",\"enforced\":[\"img-src\"],\"unsupported\":[],\"sources\":{\"img-src\":[{\"k\":\"host\",\"host\":\"a.com\",\"wildcard\":false}]},\"defaultSrc\":null}"
        );
    }

    #[test]
    fn rules_json_exact() {
        let j = parse_rules_js(
            "block \"a.com\" { types \"script\" \"image\" }\nallow \"b.net\"\nrewrite \"c.io\" \"d.io\"\nmodify \"e.dev\" { header \"x-a\" \"1\"; header \"x-b\" \"q\\\"v\" }\n",
        )
        .unwrap();
        assert_eq!(
            j,
            "{\"block\":[{\"host\":\"a.com\",\"types\":[\"script\",\"image\"]}],\"allow\":[{\"host\":\"b.net\"}],\"rewrite\":[{\"from\":\"c.io\",\"to\":\"d.io\"}],\"modify\":[{\"host\":\"e.dev\",\"headers\":{\"x-a\":\"1\",\"x-b\":\"q\\\"v\"}}]}"
        );
    }

    #[test]
    fn siteconfig_json_exact() {
        let j = parse_siteconfig_js(
            "site \"A.com\" {\n  location-rewrite \"hybrid\" max-bytes=65536\n  inject \"/x.js\"\n  fingerprint {\n    x \"1\"\n    n 2.5\n  }\n}\nsite \"b.org\" {}",
        )
        .unwrap();
        assert_eq!(
            j,
            "{\"a.com\":{\"locationRewrite\":{\"mode\":\"hybrid\",\"maxBytes\":65536},\"inject\":[\"/x.js\"],\"fingerprint\":{\"x\":\"1\",\"n\":2.5}},\"b.org\":{}}"
        );
    }

    #[test]
    fn parse_failure_is_none() {
        assert_eq!(parse_rules_js("block \""), None);
        assert_eq!(parse_siteconfig_js("site \""), None);
    }

    #[test]
    fn redact_passthrough() {
        assert_eq!(
            redact_secrets_js("https://u:p@x.test/"),
            "https://[redacted]@x.test/"
        );
    }

    /* #633 live incident: a bare-origin header value (Origin or
    access-control-allow-origin) ended the userinfo scan at the
    end of input and the '@' check indexed out of bounds. */
    #[test]
    fn bare_origin_redaction_does_not_trap() {
        assert_eq!(
            redact_secrets_js("https://accounts.google.com"),
            "https://accounts.google.com"
        );
    }
}
