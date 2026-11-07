//! #616 configs oracle: the shipped fixture files plus grammar
//! edges, ported from rules.test.ts (parseRulesKdl rows),
//! siteconfig-hostkeys.test.ts (#265), location-policy.test.ts
//! (#456) and the kdlNodeValue data-path rows of
//! siteconfig-profile.test.ts (#80). The TS corpus is the spec.

use zeolite_config::kdl::parse_kdl;
use zeolite_config::rules::location_policy;
use zeolite_config::rules::KdlData::{List, Map, Str};
use zeolite_config::{parse_rules, rules_from_nodes, LocationMode, LocationPolicy, SiteRule};

/// The shipped /rules.kdl fixture (app/public/rules.kdl).
const RULES_KDL: &str = r#"// Default interception rules (Phase 1). The ad + tracker host lists
// are migrated from the browser app's server-side engine so
// client-side mode blocks the same hosts. allow = captcha/anti-bot
// widget hosts that must never be stripped (same policy as the
// server engine). Grammar: docs/interception.md.

block "doubleclick.net"
block "googlesyndication.com"
block "googleadservices.com"
block "adservice.google.com"
block "adnxs.com"
block "adsrvr.org"
block "criteo.com"
block "taboola.com"
block "outbrain.com"
block "rubiconproject.com"
block "pubmatic.com"
block "openx.net"
block "smartadserver.com"
block "teads.tv"
block "google-analytics.com"
block "googletagmanager.com"
block "analytics.google.com"
block "scorecardresearch.com"
block "quantserve.com"
block "hotjar.com"
block "mouseflow.com"
block "fullstory.com"
block "clarity.ms"
block "segment.io"
block "mixpanel.com"
block "amplitude.com"

allow "challenges.cloudflare.com"
allow "cloudflare.com"
allow "js.stripe.com"
allow "hcaptcha.com"
allow "www.google.com"
allow "recaptcha.net"
"#;

/// The shipped /siteconfig.kdl fixture (app/public/siteconfig.kdl).
const SITECONFIG_KDL: &str = r#"// Per-site compatibility rules (grammar: app/src/siteconfig.ts).
// Compat-suite failures become rules here, never hardcoded branches.

// #456 Wave 2 / #432: the play2048.co SPA router reads
// location.pathname, route-matches against the engine query shape and
// serves its own 404 on the correct URL (LegacyUnforgeable-location
// class). Hybrid pre-execution location rewrite enabled for this
// origin only (reads-only shim, bounded, fail-open); every other
// origin keeps the legacy mode. Scoreboard nightly validation of this
// rule is pending; remove or extend per that evidence.
site "play2048.co" {
  location-rewrite "hybrid"
}
"#;

#[test]
fn parses_the_shipped_rules_fixture() {
    let data = parse_rules(&parse_kdl(RULES_KDL).unwrap());
    assert_eq!(data.block.len(), 26);
    assert_eq!(data.allow.len(), 6);
    assert_eq!(data.block[0].host, "doubleclick.net");
    assert_eq!(data.block[25].host, "amplitude.com");
    assert!(data.block.iter().all(|e| e.types.is_none()));
    let allow_hosts: Vec<&str> = data.allow.iter().map(|e| e.host.as_str()).collect();
    assert_eq!(
        allow_hosts,
        [
            "challenges.cloudflare.com",
            "cloudflare.com",
            "js.stripe.com",
            "hcaptcha.com",
            "www.google.com",
            "recaptcha.net",
        ]
    );
    assert!(data.rewrite.is_empty());
    assert!(data.modify.is_empty());
}

#[test]
fn types_children_filter_and_skip_semantics() {
    let kdl = "block \"ads.example\" { types \"script\" \"image\" 5 }\nblock \"plain.example\"\nallow \"captcha.example\" { types }\nunknown \"x\"\nblock 5\nblock \"\"";
    let data = parse_rules(&parse_kdl(kdl).unwrap());
    assert_eq!(data.block.len(), 2);
    assert_eq!(
        data.block[0].types,
        Some(vec!["script".to_string(), "image".to_string()])
    );
    assert_eq!(data.block[1].types, None);
    assert_eq!(data.allow[0].types, Some(Vec::new()));
    assert_eq!(data.allow[0].host, "captcha.example");
}

#[test]
fn rewrite_entries_require_nonempty_from_and_to() {
    let kdl = "rewrite \"http://a/\" \"https://a/\"\nrewrite \"only-from\"\nrewrite \"\" \"x\"\nrewrite \"a\" \"\"\nrewrite \"a\" 5";
    let data = parse_rules(&parse_kdl(kdl).unwrap());
    assert_eq!(data.rewrite.len(), 1);
    assert_eq!(data.rewrite[0].from, "http://a/");
    assert_eq!(data.rewrite[0].to, "https://a/");
}

#[test]
fn modify_headers_dedupe_last_wins() {
    let kdl = "modify \"news.example\" { types \"fetch\"; header \"x-a\" \"1\"; header \"x-b\" \"2\"; header \"x-a\" \"3\"; other \"y\" }\nmodify \"no-headers.example\"";
    let data = parse_rules(&parse_kdl(kdl).unwrap());
    assert_eq!(data.modify.len(), 2);
    assert_eq!(data.modify[0].types, Some(vec!["fetch".to_string()]));
    assert_eq!(
        data.modify[0].headers,
        [
            ("x-a".to_string(), "3".to_string()),
            ("x-b".to_string(), "2".to_string()),
        ]
    );
    assert_eq!(data.modify[1].headers, []);
}

#[test]
fn host_keys_lowercased_at_parse() {
    let rules = rules_from_nodes(
        &parse_kdl("site \"Coherent.Example\" { block \"ads.example\" }").unwrap(),
    );
    let keys: Vec<&str> = rules.keys().map(|k| k.as_str()).collect();
    assert_eq!(keys, ["coherent.example"]);
    assert_eq!(
        rules["coherent.example"].block,
        Some(vec!["ads.example".to_string()])
    );
}

#[test]
fn rejects_non_host_keys_instead_of_keeping_dead_entries() {
    let kdl = [
        "site \"https://evil.example/\" { inject \"x.js\" }",
        "site \"*.wildcard.example\" { inject \"y.js\" }",
        "site \"ok.example\" { block \"b\" }",
        "site \"\" { block \"never\" }",
        "site \"-leadingdash.example\" { block \"never\" }",
    ]
    .join("\n");
    let rules = rules_from_nodes(&parse_kdl(&kdl).unwrap());
    let keys: Vec<&str> = rules.keys().map(|k| k.as_str()).collect();
    assert_eq!(keys, ["ok.example"]);
}

#[test]
fn default_policy_is_legacy_two_mib() {
    assert_eq!(
        location_policy(&SiteRule::default()),
        LocationPolicy {
            mode: LocationMode::Legacy,
            max_bytes: 2 * 1024 * 1024,
        }
    );
}

#[test]
fn parses_bounded_hybrid_and_off_controls() {
    let kdl = "site \"example.com\" { location-rewrite \"hybrid\" max-bytes=65536 }\nsite \"private.example.com\" { location-rewrite \"off\" }";
    let rules = rules_from_nodes(&parse_kdl(kdl).unwrap());
    let policy = location_policy(&rules["example.com"]);
    assert_eq!(policy.mode, LocationMode::Hybrid);
    assert_eq!(policy.max_bytes, 65536);
    let off = location_policy(&rules["private.example.com"]);
    assert_eq!(off.mode, LocationMode::Off);
    // Only hybrid takes the 512KiB default cap; off keeps 2MiB.
    assert_eq!(off.max_bytes, 2 * 1024 * 1024);
}

#[test]
fn rejects_invalid_modes_and_caps() {
    for spec in [
        "\"auto\"",
        "\"hybrid\" max-bytes=0",
        "\"hybrid\" max-bytes=2097153",
        "\"hybrid\" max-bytes=1.5",
        "\"legacy\" max-bytes=\"x\"",
    ] {
        let kdl = format!("site \"example.com\" {{ location-rewrite {} }}", spec);
        let rules = rules_from_nodes(&parse_kdl(&kdl).unwrap());
        assert_eq!(
            location_policy(&rules["example.com"]).mode,
            LocationMode::Legacy,
            "spec: {}",
            spec
        );
    }
}

#[test]
fn ships_hybrid_for_the_play2048_class_only() {
    let rules = rules_from_nodes(&parse_kdl(SITECONFIG_KDL).unwrap());
    let keys: Vec<&str> = rules.keys().map(|k| k.as_str()).collect();
    assert_eq!(keys, ["play2048.co"]);
    assert_eq!(
        location_policy(&rules["play2048.co"]),
        LocationPolicy {
            mode: LocationMode::Hybrid,
            max_bytes: 512 * 1024,
        }
    );
}

#[test]
fn fingerprint_child_node_value_shapes() {
    let kdl = "site \"a.test\" { fingerprint \"UA/1.0\" }\nsite \"b.test\" { fingerprint \"a\" \"b\" }\nsite \"c.test\" { fingerprint }\nsite \"d.test\" { fingerprint #null }\nsite \"e.test\" { fingerprint userAgent=\"UA\" engines=\"epoxy\" }\nsite \"f.test\" { fingerprint { userAgent \"UA\" } }\nsite \"g.test\" { fingerprint userAgent=\"A\" { userAgent \"B\" } }";
    let rules = rules_from_nodes(&parse_kdl(kdl).unwrap());
    assert_eq!(rules["a.test"].fingerprint, Some(Str("UA/1.0".into())));
    assert_eq!(
        rules["b.test"].fingerprint,
        Some(List(vec![Str("a".into()), Str("b".into())]))
    );
    assert_eq!(rules["c.test"].fingerprint, None);
    assert_eq!(rules["d.test"].fingerprint, None);
    assert_eq!(
        rules["e.test"].fingerprint,
        Some(Map(vec![
            ("userAgent".into(), Str("UA".into())),
            ("engines".into(), Str("epoxy".into())),
        ]))
    );
    assert_eq!(
        rules["f.test"].fingerprint,
        Some(Map(vec![("userAgent".into(), Str("UA".into()))]))
    );
    // A child overrides a same-named prop, keeping the position.
    assert_eq!(
        rules["g.test"].fingerprint,
        Some(Map(vec![("userAgent".into(), Str("B".into()))]))
    );
}

#[test]
fn inject_block_plugins_set_even_with_no_string_args() {
    let kdl = "site \"x.test\" { inject \"/a.js\" \"/b.js\"; block 5 \"b\"; plugins }\nsite \"y.test\" { mystery \"z\" }";
    let rules = rules_from_nodes(&parse_kdl(kdl).unwrap());
    assert_eq!(
        rules["x.test"].inject,
        Some(vec!["/a.js".to_string(), "/b.js".to_string()])
    );
    assert_eq!(rules["x.test"].block, Some(vec!["b".to_string()]));
    assert_eq!(rules["x.test"].plugins, Some(Vec::new()));
    assert_eq!(rules["y.test"], SiteRule::default());
}
