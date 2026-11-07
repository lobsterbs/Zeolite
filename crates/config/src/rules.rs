//! Typed rules and siteconfig layers (port of parseRulesKdl in
//! rules.ts and rulesFromNodes/kdlNodeValue in siteconfig.ts):
//! the pure data shapes the interception and siteconfig runtimes
//! consume. Skip semantics match TS exactly - unknown node names
//! are ignored, non-string/empty hosts are dropped, a bad file
//! still means "no rules".
//!
//! Not ported here (#616 scope): compileRules/applyRules URL
//! matching (the interception runtime), ruleFor host-suffix
//! matching and the fingerprint profile resolution - they need a
//! URL parser and the fingerprint registry, which stay TS-side
//! until the wasm-bindgen wiring phase.

use std::collections::BTreeMap;

use crate::kdl::{KdlNode, KdlValue};

/// A fingerprint child node as profile data (#80): props and
/// children become a map, a single arg the value, several args a
/// list, none (or a #null arg) null - which the site rule drops.
#[derive(Debug, Clone, PartialEq)]
pub enum KdlData {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<KdlData>),
    Map(Vec<(String, KdlData)>),
}

impl KdlData {
    /// Last-wins key lookup on a Map, mirroring JS object access.
    pub fn get(&self, key: &str) -> Option<&KdlData> {
        match self {
            KdlData::Map(entries) => entries.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

fn kdl_value_data(v: &KdlValue) -> KdlData {
    match v {
        KdlValue::Str(s) => KdlData::Str(s.clone()),
        KdlValue::Num(n) => KdlData::Num(*n),
        KdlValue::Bool(b) => KdlData::Bool(*b),
        KdlValue::Null => KdlData::Null,
    }
}

/// Insert with TS object-assignment semantics: an existing key
/// keeps its position and takes the new value (last wins).
fn map_insert(map: &mut Vec<(String, KdlData)>, key: String, value: KdlData) {
    if let Some(slot) = map.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = value;
    } else {
        map.push((key, value));
    }
}

/// #80: a node as profile data; children override same-named
/// props, matching the TS spread order.
pub fn kdl_node_value(node: &KdlNode) -> KdlData {
    if !node.children.is_empty() || !node.props.is_empty() {
        let mut map: Vec<(String, KdlData)> = Vec::new();
        for (k, v) in &node.props {
            map_insert(&mut map, k.clone(), kdl_value_data(v));
        }
        for child in &node.children {
            map_insert(&mut map, child.name.clone(), kdl_node_value(child));
        }
        return KdlData::Map(map);
    }
    match node.args.as_slice() {
        [single] => kdl_value_data(single),
        [] => KdlData::Null,
        many => KdlData::List(many.iter().map(kdl_value_data).collect()),
    }
}

/// One block/allow host; types None means all resource types.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HostEntry {
    pub host: String,
    pub types: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RewriteEntry {
    pub from: String,
    pub to: String,
    pub types: Option<Vec<String>>,
}

/// Headers keep insertion order with last-wins duplicates, the
/// same shape compileRules spreads into outgoing requests.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ModifyEntry {
    pub host: String,
    pub headers: Vec<(String, String)>,
    pub types: Option<Vec<String>>,
}

/// parse_rules output: the four lists (parseRulesKdl in TS).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RulesData {
    pub block: Vec<HostEntry>,
    pub allow: Vec<HostEntry>,
    pub rewrite: Vec<RewriteEntry>,
    pub modify: Vec<ModifyEntry>,
}

/// Resource-type filter of an entry node: the string args of the
/// first types child; None when the child is absent.
fn types_of(node: &KdlNode) -> Option<Vec<String>> {
    node.children.iter().find(|c| c.name == "types").map(|t| {
        t.args
            .iter()
            .filter_map(|a| match a {
                KdlValue::Str(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    })
}

fn header_insert(headers: &mut Vec<(String, String)>, name: String, value: String) {
    if let Some(slot) = headers.iter_mut().find(|(k, _)| *k == name) {
        slot.1 = value;
    } else {
        headers.push((name, value));
    }
}

/// Parse the rules.kdl grammar into rule data (parseRulesKdl).
/// Unknown node names are skipped, like the old JSON parser
/// ignored unknown fields; a bad file still means "no rules".
pub fn parse_rules(doc: &[KdlNode]) -> RulesData {
    let mut data = RulesData::default();
    for node in doc {
        let host = match node.args.first() {
            Some(KdlValue::Str(s)) if !s.is_empty() => s.clone(),
            _ => continue,
        };
        match node.name.as_str() {
            "block" => data.block.push(HostEntry {
                host,
                types: types_of(node),
            }),
            "allow" => data.allow.push(HostEntry {
                host,
                types: types_of(node),
            }),
            "rewrite" => {
                let to = match node.args.get(1) {
                    Some(KdlValue::Str(to)) if !to.is_empty() => to.clone(),
                    _ => continue,
                };
                data.rewrite.push(RewriteEntry {
                    from: host,
                    to,
                    types: types_of(node),
                });
            }
            "modify" => {
                let mut headers: Vec<(String, String)> = Vec::new();
                for c in &node.children {
                    if c.name != "header" {
                        continue;
                    }
                    if let (Some(KdlValue::Str(n)), Some(KdlValue::Str(v))) =
                        (c.args.first(), c.args.get(1))
                    {
                        header_insert(&mut headers, n.clone(), v.clone());
                    }
                }
                data.modify.push(ModifyEntry {
                    host,
                    headers,
                    types: types_of(node),
                });
            }
            _ => {}
        }
    }
    data
}

/// location-rewrite modes (#456): legacy document rewrite, the
/// bounded hybrid pre-execution shim, or off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationMode {
    Legacy,
    Hybrid,
    Off,
}

/// A bounded location-rewrite policy; the cap is an integer byte
/// count in (0, 2MiB].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationPolicy {
    pub mode: LocationMode,
    pub max_bytes: usize,
}

impl Default for LocationPolicy {
    fn default() -> Self {
        LocationPolicy {
            mode: LocationMode::Legacy,
            max_bytes: 2 * 1024 * 1024,
        }
    }
}

/// Effective policy of a rule (TS locationPolicy): the rule's
/// bounded policy or the legacy default.
pub fn location_policy(rule: &SiteRule) -> LocationPolicy {
    rule.location_rewrite.clone().unwrap_or_default()
}

/// One per-site rule (TS SiteRule). inject/block/plugins are Some
/// when the child node exists, even with no string args, exactly
/// like the TS assignment.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SiteRule {
    pub location_rewrite: Option<LocationPolicy>,
    pub inject: Option<Vec<String>>,
    pub block: Option<Vec<String>>,
    pub plugins: Option<Vec<String>>,
    pub fingerprint: Option<KdlData>,
}

pub type SiteRules = BTreeMap<String, SiteRule>;

/// ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ on the lowercased key: a
/// single alnum char, or alnum ends around alnum/./- middles.
fn is_bare_hostname(key: &str) -> bool {
    let b = key.as_bytes();
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.len() {
        0 => return false,
        1 => return alnum(b[0]),
        _ => {}
    }
    if !alnum(b[0]) || !alnum(b[b.len() - 1]) {
        return false;
    }
    b[1..b.len() - 1]
        .iter()
        .all(|&c| alnum(c) || c == b'.' || c == b'-')
}

/// location-rewrite child: mode plus an optional integer byte
/// cap; the default cap is 512KiB for hybrid, 2MiB otherwise
/// (JS ??: an absent or #null prop takes the default). A bad
/// mode or cap skips the child, never a silently enabled policy.
fn apply_location_rewrite(rule: &mut SiteRule, child: &KdlNode) {
    let mode_str = match child.args.first() {
        Some(KdlValue::Str(s)) => Some(s.as_str()),
        _ => None,
    };
    let max = match child.prop("max-bytes") {
        Some(KdlValue::Num(n)) => *n,
        Some(KdlValue::Null) | None => {
            if mode_str == Some("hybrid") {
                512.0 * 1024.0
            } else {
                2.0 * 1024.0 * 1024.0
            }
        }
        // A non-number prop (string/bool) never passes the
        // integer cap check below, matching the TS typeof test.
        Some(_) => f64::NAN,
    };
    let mode = match mode_str {
        Some("legacy") => Some(LocationMode::Legacy),
        Some("hybrid") => Some(LocationMode::Hybrid),
        Some("off") => Some(LocationMode::Off),
        _ => None,
    };
    if let Some(mode) = mode {
        // NaN fails the fract test, so no NaN cast can happen.
        if max.fract() == 0.0 && max > 0.0 && max <= 2.0 * 1024.0 * 1024.0 {
            rule.location_rewrite = Some(LocationPolicy {
                mode,
                max_bytes: max as usize,
            });
        }
    }
}

/// KDL site nodes -> rules map (rulesFromNodes, #265): host keys
/// are normalized to lowercase at parse time - DNS names are
/// case-insensitive and ruleFor matches against the lowercased
/// URL hostname, so a mixed-case key would silently never match.
/// A key that is not a bare hostname never matches the suffix
/// rule and is dropped at parse rather than lingering.
pub fn rules_from_nodes(nodes: &[KdlNode]) -> SiteRules {
    let mut rules = SiteRules::new();
    for node in nodes {
        if node.name != "site" {
            continue;
        }
        let host = match node.args.first() {
            Some(KdlValue::Str(h)) if !h.is_empty() => h,
            _ => continue,
        };
        let key = host.to_lowercase();
        if !is_bare_hostname(&key) {
            continue;
        }
        let mut rule = SiteRule::default();
        for child in &node.children {
            let strs: Vec<String> = child
                .args
                .iter()
                .filter_map(|a| match a {
                    KdlValue::Str(s) => Some(s.clone()),
                    _ => None,
                })
                .collect();
            match child.name.as_str() {
                "location-rewrite" => apply_location_rewrite(&mut rule, child),
                "inject" => rule.inject = Some(strs),
                "block" => rule.block = Some(strs),
                "plugins" => rule.plugins = Some(strs),
                "fingerprint" => {
                    let v = kdl_node_value(child);
                    if v != KdlData::Null {
                        rule.fingerprint = Some(v);
                    }
                }
                _ => {}
            }
        }
        rules.insert(key, rule);
    }
    rules
}
