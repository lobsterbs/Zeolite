//! #614 wiring: the wasm-bindgen wrapper over zeolite-cookies.
//!
//! This crate is the WORKING jar the service worker drives: one
//! Profile per cookie namespace, mirroring the TS jars map split
//! by namespace key. The TS seam (cookies.ts) keeps persistence,
//! profile assignment and every facade surface; it calls these
//! exports and falls back to its own TS body whenever the module
//! is missing, older, or its init failed, exactly like the
//! rewriter/seam/adblock precedents.
//!
//! Boundary contract: every export is strings-in/JSON-out with
//! the camelCase cookie shape the TS seam already stores
//! (name, value, domain, hostOnly, path, secure, httpOnly,
//! sameSite, expires, created) and the TS reject strings, so the
//! TS arm maps outcomes without translation. The public-suffix
//! gate is injected at init (setPsl): unset or throwing fails
//! CLOSED (treated as a public suffix) so a broken PSL can never
//! widen the Domain gate.
//!
//! The storage admission contract of the Profile holds here too:
//! every Stored outcome runs the capacity sweep with the fresh
//! identity protected and reports the evicted cookies, so the TS
//! arm can note evictions exactly like its own sweepJarLimits.

use std::cell::RefCell;
use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

use zeolite_cookies::profile::{CookieIdentity, MergeRule, Profile};
use zeolite_cookies::url::parse_http_url;
use zeolite_cookies::{Cookie, Reject, SameSite, StoreOutcome};

thread_local! {
    /// One Profile per cookie namespace (the TS namespace strings:
    /// "default", "client:...:...", "legacy:...", the unbound one).
    static REGISTRY: RefCell<BTreeMap<String, Profile>> = const { RefCell::new(BTreeMap::new()) };
    /// The tldts predicate injected at init. None fails closed.
    static PSL: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// The injected PSL predicate. Unset, throwing or non-boolean
/// answers count as a public suffix: the Domain gate refuses.
fn is_public_suffix(domain: &str) -> bool {
    PSL.with(|cell| {
        let f = cell.borrow().clone();
        let Some(f) = f else { return true };
        match f.call1(&JsValue::NULL, &JsValue::from(domain)) {
            Ok(v) => v.as_bool().unwrap_or(true),
            Err(_) => true,
        }
    })
}

/// Run f against the namespace profile. init inserts an empty
/// profile for a missing namespace (mutating calls); reads on a
/// missing namespace answer None and the caller fails safe.
fn with_ns<R>(ns: &str, init: bool, f: impl FnOnce(&mut Profile) -> R) -> Option<R> {
    REGISTRY.with(|cell| {
        let mut reg = cell.borrow_mut();
        let p = match init {
            true => reg.entry(ns.to_string()).or_default(),
            false => match reg.get_mut(ns) {
                Some(p) => p,
                None => return None,
            },
        };
        Some(f(p))
    })
}

fn same_site_json(s: Option<SameSite>) -> Value {
    match s {
        Some(SameSite::Lax) => json!("lax"),
        Some(SameSite::Strict) => json!("strict"),
        Some(SameSite::None) => json!("none"),
        None => Value::Null,
    }
}

fn cookie_json(c: &Cookie) -> Value {
    json!({
        "name": c.name,
        "value": c.value,
        "domain": c.domain,
        "hostOnly": c.host_only,
        "path": c.path,
        "secure": c.secure,
        "httpOnly": c.http_only,
        "sameSite": same_site_json(c.same_site),
        "expires": c.expires,
        "created": c.created,
    })
}

/// The TS isStoredCookie gate: a record missing any of the
/// storage fields (value included) is dropped, never admitted.
fn cookie_from_json(v: &Value) -> Option<Cookie> {
    let name = v.get("name")?.as_str()?;
    let value = v.get("value")?.as_str()?;
    let domain = v.get("domain")?.as_str()?;
    let host_only = v.get("hostOnly")?.as_bool()?;
    let path = v.get("path")?.as_str()?;
    let secure = v.get("secure")?.as_bool()?;
    let http_only = v.get("httpOnly")?.as_bool()?;
    let expires = v.get("expires")?.as_i64()?;
    let created = v.get("created")?.as_i64()?;
    let same_site = match v.get("sameSite") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => match s.as_str() {
            "lax" => Some(SameSite::Lax),
            "strict" => Some(SameSite::Strict),
            "none" => Some(SameSite::None),
            _ => return None,
        },
        _ => return None,
    };
    Some(Cookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: domain.to_string(),
        host_only,
        path: path.to_string(),
        secure,
        http_only,
        same_site,
        expires,
        created,
    })
}

/// Best-effort name for an outcome: the token before the first
/// equals sign of the first pair. Rejected headers still report a
/// name so the TS arm can shape its SetCookieResult.
fn header_name(header: &str) -> String {
    let first = header.split(';').next().unwrap_or("");
    let pair = first.trim();
    let Some(eq) = pair.find('=') else {
        return String::new();
    };
    let name = pair[..eq].trim();
    if name.is_empty() || name.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return String::new();
    }
    name.to_string()
}

fn reject_str(r: &Reject) -> &'static str {
    match r {
        Reject::Malformed => "malformed",
        Reject::ControlCharacter => "control character",
        Reject::SameSiteNoneWithoutSecure => "samesite none without secure",
        Reject::SecureFromInsecureOrigin => "secure from insecure origin",
        Reject::Domain => "domain",
        Reject::PrefixRequiresSecure => "prefix requires secure",
        Reject::HostPrefixRequiresRoot => "__Host- requires host-only and path /",
        Reject::Size => "size",
        Reject::HttpOnlyScriptWrite => "httponly",
    }
}

/// The SetCookieResult shape the TS arm consumes: stored carries
/// the fresh cookie, the replaced flag and the admission sweep's
/// evicted list; deleted carries the earliest-created retired copy
/// and replaced: true (TS parity); rejected carries the TS reason
/// string.
fn outcome_json(name: &str, out: &StoreOutcome, evicted: &[Cookie]) -> Value {
    match out {
        StoreOutcome::Stored {
            cookie, replaced, ..
        } => json!({
            "name": name,
            "stored": true,
            "deleted": false,
            "cookie": cookie_json(cookie),
            "replaced": replaced,
            "evicted": evicted.iter().map(cookie_json).collect::<Vec<_>>(),
        }),
        StoreOutcome::Deleted { cookie } => json!({
            "name": name,
            "stored": false,
            "deleted": true,
            "cookie": cookie.as_ref().map(cookie_json),
            "replaced": true,
        }),
        StoreOutcome::Noop => json!({
            "name": name,
            "stored": false,
            "deleted": false,
        }),
        StoreOutcome::Rejected(r) => json!({
            "name": name,
            "stored": false,
            "deleted": false,
            "rejected": reject_str(r),
        }),
    }
}

fn empty_match_json() -> String {
    json!({"matched": [], "purged": []}).to_string()
}

fn empty_counts_json() -> String {
    json!({"jars": 0, "cookies": 0, "conflicts": 0}).to_string()
}

/// One namespace as the import/export shape: [[bucketId,
/// [cookie, ...]], ...] in bucket-key order.
fn profile_entries(p: &Profile) -> Value {
    Value::Array(
        p.buckets()
            .map(|(id, list)| json!([id, list.iter().map(cookie_json).collect::<Vec<_>>(),]))
            .collect::<Vec<_>>(),
    )
}

/// The tldts predicate, injected once at init before any store.
#[wasm_bindgen(js_name = "setPsl")]
pub fn set_psl(f: js_sys::Function) {
    PSL.with(|cell| *cell.borrow_mut() = Some(f));
}

/// Admit a batch of raw Set-Cookie headers for one response
/// origin into one bucket. Returns the outcome array in header
/// order. Malformed arguments fail safe: no admissions, [].
#[wasm_bindgen(js_name = "storeBatch")]
pub fn store_batch(
    ns: &str,
    bucket: &str,
    origin_url: &str,
    headers_json: &str,
    from_script: bool,
    now: f64,
) -> String {
    let Some(origin) = parse_http_url(origin_url) else {
        return "[]".to_string();
    };
    let Ok(headers) = serde_json::from_str::<Vec<String>>(headers_json) else {
        return "[]".to_string();
    };
    let now = now as i64;
    with_ns(ns, true, |p| {
        Value::Array(
            headers
                .iter()
                .map(|h| {
                    let name = header_name(h);
                    let out = p.store(bucket, &origin, h, from_script, now, is_public_suffix);
                    let evicted = match &out {
                        StoreOutcome::Stored { cookie, .. } => p.sweep(Some(cookie), now),
                        _ => Vec::new(),
                    };
                    outcome_json(&name, &out, &evicted)
                })
                .collect::<Vec<_>>(),
        )
        .to_string()
    })
    .unwrap_or_else(|| "[]".to_string())
}

/// RFC 6265 5.4 request matching: the matched cookies in 5.4
/// order plus the lazily purged expired ones (the TS seam
/// reschedules persistence when purged is non-empty).
#[wasm_bindgen(js_name = "matchRequest")]
pub fn match_request_js(ns: &str, request_url: &str, now: f64) -> String {
    let Some(origin) = parse_http_url(request_url) else {
        return empty_match_json();
    };
    with_ns(ns, false, |p| {
        let (matched, purged) = p.match_request(&origin, now as i64);
        json!({
            "matched": matched.iter().map(cookie_json).collect::<Vec<_>>(),
            "purged": purged.iter().map(cookie_json).collect::<Vec<_>>(),
        })
        .to_string()
    })
    .unwrap_or_else(empty_match_json)
}

/// The document.cookie oracle: matched cookies in 5.4 order, no
/// HttpOnly, no expired.
#[wasm_bindgen(js_name = "matchDocument")]
pub fn match_document_js(ns: &str, page_url: &str, now: f64) -> String {
    let Some(origin) = parse_http_url(page_url) else {
        return "[]".to_string();
    };
    REGISTRY.with(|cell| {
        let reg = cell.borrow();
        let Some(p) = reg.get(ns) else {
            return "[]".to_string();
        };
        Value::Array(
            p.match_document(&origin, now as i64)
                .iter()
                .map(cookie_json)
                .collect::<Vec<_>>(),
        )
        .to_string()
    })
}

/// The 6.1 capacity sweep without protection (the persist seam's
/// contract). Returns the removed cookies.
#[wasm_bindgen(js_name = "sweep")]
pub fn sweep_js(ns: &str, now: f64) -> String {
    with_ns(ns, false, |p| {
        Value::Array(
            p.sweep(None, now as i64)
                .iter()
                .map(cookie_json)
                .collect::<Vec<_>>(),
        )
        .to_string()
    })
    .unwrap_or_else(|| "[]".to_string())
}

/// Retire identities wherever they live in the namespace; every
/// matching cookie dies. Returns how many were removed.
#[wasm_bindgen(js_name = "removeIdentities")]
pub fn remove_identities_js(ns: &str, ids_json: &str) -> usize {
    let Ok(arr) = serde_json::from_str::<Vec<Value>>(ids_json) else {
        return 0;
    };
    let ids: Vec<CookieIdentity> = arr
        .iter()
        .filter_map(|v| {
            Some(CookieIdentity {
                name: v.get("name")?.as_str()?.to_string(),
                domain: v.get("domain")?.as_str()?.to_string(),
                host_only: v.get("hostOnly")?.as_bool()?,
                path: v.get("path")?.as_str()?.to_string(),
            })
        })
        .collect();
    with_ns(ns, false, |p| p.remove_identities(&ids)).unwrap_or(0)
}

/// One namespace exported as [[bucketId, [cookie, ...]], ...].
#[wasm_bindgen(js_name = "exportNs")]
pub fn export_ns_js(ns: &str) -> String {
    REGISTRY.with(|cell| {
        let reg = cell.borrow();
        let Some(p) = reg.get(ns) else {
            return "[]".to_string();
        };
        profile_entries(p).to_string()
    })
}

/// Every namespace: { ns: [[bucketId, [cookie, ...]], ...] }.
#[wasm_bindgen(js_name = "exportAll")]
pub fn export_all_js() -> String {
    REGISTRY.with(|cell| {
        let reg = cell.borrow();
        let mut m = Map::new();
        for (ns, p) in reg.iter() {
            m.insert(ns.clone(), profile_entries(p));
        }
        Value::Object(m).to_string()
    })
}

/// Replace a whole namespace from the export shape. Malformed
/// records are dropped, never admitted; empty buckets drop, like
/// the TS seams that never store empty jars. Returns how many
/// cookies the namespace now holds.
#[wasm_bindgen(js_name = "replaceNs")]
pub fn replace_ns_js(ns: &str, entries_json: &str) -> usize {
    let Ok(entries) = serde_json::from_str::<Vec<Value>>(entries_json) else {
        return 0;
    };
    with_ns(ns, true, |p| {
        p.clear();
        for e in &entries {
            let Some(pair) = e.as_array() else { continue };
            if pair.len() != 2 {
                continue;
            }
            let Some(id) = pair[0].as_str() else { continue };
            let Some(list) = pair[1].as_array() else {
                continue;
            };
            let cookies: Vec<Cookie> = list.iter().filter_map(cookie_from_json).collect();
            p.set_bucket(id, cookies);
        }
        p.buckets().map(|(_, list)| list.len()).sum()
    })
    .unwrap_or(0)
}

/// Session-import merge (jarMerge): bucket-local conflicts resolve
/// by the rule ("import-wins" default, "keep-newest" the other).
/// Returns { jars, cookies, conflicts } like the TS seam.
#[wasm_bindgen(js_name = "mergeNs")]
pub fn merge_ns_js(ns: &str, entries_json: &str, rule: &str) -> String {
    let rule = match rule {
        "keep-newest" => MergeRule::KeepNewest,
        "keep-existing" => MergeRule::KeepExisting,
        _ => MergeRule::ImportWins,
    };
    let Ok(entries) = serde_json::from_str::<Vec<Value>>(entries_json) else {
        return empty_counts_json();
    };
    let parsed: Vec<(String, Vec<Cookie>)> = entries
        .iter()
        .filter_map(|e| {
            let pair = e.as_array()?;
            if pair.len() != 2 {
                return None;
            }
            let id = pair[0].as_str()?.to_string();
            let list = pair[1].as_array()?;
            Some((id, list.iter().filter_map(cookie_from_json).collect()))
        })
        .collect();
    with_ns(ns, true, |p| {
        let (jars, cookies, conflicts) = p.merge(&parsed, rule);
        json!({"jars": jars, "cookies": cookies, "conflicts": conflicts}).to_string()
    })
    .unwrap_or_else(empty_counts_json)
}

/// Clear one namespace; returns { jars, cookies } counts.
#[wasm_bindgen(js_name = "clearNs")]
pub fn clear_ns_js(ns: &str) -> String {
    with_ns(ns, false, |p| {
        let (jars, cookies) = p.clear();
        json!({"jars": jars, "cookies": cookies}).to_string()
    })
    .unwrap_or_else(|| json!({"jars": 0, "cookies": 0}).to_string())
}

/// Clear one origin bucket; returns how many cookies died.
#[wasm_bindgen(js_name = "clearBucket")]
pub fn clear_bucket_js(ns: &str, bucket: &str) -> usize {
    with_ns(ns, false, |p| p.clear_bucket(bucket)).unwrap_or(0)
}

/// Teardown: cookies do not survive an engine switch. The PSL
/// predicate stays: it is an init-time injection, not jar state.
#[wasm_bindgen(js_name = "clearAll")]
pub fn clear_all_js() {
    REGISTRY.with(|cell| cell.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_000_000.0;
    const LATER: f64 = 2_000_000.0;

    fn arr(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    /* JSON headers composed at runtime: the source carries no
    string-literal escapes. */
    fn headers(list: &[&str]) -> String {
        serde_json::to_string(list).unwrap()
    }

    #[test]
    fn store_and_match_roundtrip() {
        let out = store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1"]),
            false,
            NOW,
        );
        let o = arr(&out)[0].clone();
        assert_eq!(o["name"], "k");
        assert_eq!(o["stored"], true);
        assert_eq!(o["deleted"], false);
        assert_eq!(o["cookie"]["value"], "1");
        assert_eq!(o["cookie"]["hostOnly"], true);
        assert_eq!(o["cookie"]["domain"], "a.example.com");
        assert_eq!(o["cookie"]["sameSite"], Value::Null);
        assert_eq!(o["evicted"].as_array().map(Vec::len), Some(0));
        let m = arr(&match_request_js(
            "default",
            "https://a.example.com/x",
            LATER,
        ));
        assert_eq!(m["matched"].as_array().map(Vec::len), Some(1));
        assert_eq!(m["purged"].as_array().map(Vec::len), Some(0));
        let d = arr(&match_document_js(
            "default",
            "https://a.example.com/",
            LATER,
        ));
        assert_eq!(d.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn psl_unset_fails_closed() {
        let out = store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1; Domain=example.com"]),
            false,
            NOW,
        );
        assert_eq!(arr(&out)[0]["rejected"], "domain");
        let m = arr(&match_request_js(
            "default",
            "https://a.example.com/",
            LATER,
        ));
        assert_eq!(m["matched"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn deletion_outcome_shape() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1"]),
            false,
            NOW,
        );
        let out = store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=; Max-Age=0"]),
            false,
            LATER,
        );
        let o = arr(&out)[0].clone();
        assert_eq!(o["deleted"], true);
        assert_eq!(o["replaced"], true);
        assert_eq!(o["cookie"]["value"], "1");
        let m = arr(&match_request_js(
            "default",
            "https://a.example.com/",
            LATER,
        ));
        assert_eq!(m["matched"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn noop_shape_has_no_rejected_field() {
        let out = store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=; Max-Age=0"]),
            false,
            NOW,
        );
        let o = arr(&out)[0].clone();
        assert_eq!(o["stored"], false);
        assert_eq!(o["deleted"], false);
        assert!(o.get("rejected").is_none());
    }

    #[test]
    fn control_character_reject_uses_ts_string() {
        /* The raw control character is composed at runtime so the
        source carries no escape sequences. */
        let bad = format!("k{}=1", char::from_u32(1).unwrap());
        let headers = serde_json::to_string(&vec![bad]).unwrap();
        let out = store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers,
            false,
            NOW,
        );
        assert_eq!(arr(&out)[0]["rejected"], "control character");
    }

    #[test]
    fn malformed_arguments_fail_safe() {
        assert_eq!(
            store_batch(
                "default",
                "A",
                "https://a.example.com/",
                "not json",
                false,
                NOW
            ),
            "[]"
        );
        assert_eq!(
            store_batch("default", "A", "ftp://x/", &headers(&["k=1"]), false, NOW),
            "[]"
        );
        assert_eq!(
            match_request_js("missing", "https://a.example.com/", NOW),
            empty_match_json()
        );
        assert_eq!(
            match_document_js("missing", "https://a.example.com/", NOW),
            "[]"
        );
        assert_eq!(sweep_js("missing", NOW), "[]");
        assert_eq!(export_ns_js("missing"), "[]");
        assert_eq!(remove_identities_js("missing", "[]"), 0);
        assert_eq!(clear_bucket_js("missing", "A"), 0);
    }

    #[test]
    fn export_replace_roundtrip_is_byte_equal() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1"]),
            false,
            NOW,
        );
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["j=2; HttpOnly"]),
            false,
            NOW,
        );
        let exported = export_ns_js("default");
        let count = replace_ns_js("ns2", &exported);
        assert_eq!(count, 2);
        assert_eq!(export_ns_js("ns2"), exported);
        let cleared = arr(&clear_ns_js("ns2"));
        assert_eq!(cleared["jars"], 1);
        assert_eq!(cleared["cookies"], 2);
        assert_eq!(export_ns_js("ns2"), "[]");
    }

    #[test]
    fn drop_records_missing_storage_fields() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1"]),
            false,
            NOW,
        );
        let bad =
            json!([["A", [{"name": "x", "value": "y", "domain": "a.example.com"}]]]).to_string();
        assert_eq!(replace_ns_js("ns3", &bad), 0);
        assert_eq!(export_ns_js("ns3"), "[]");
    }

    #[test]
    fn merge_counts_and_import_wins() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=old"]),
            false,
            NOW,
        );
        let c = json!({
            "name": "k",
            "value": "new",
            "domain": "a.example.com",
            "hostOnly": true,
            "path": "/",
            "secure": false,
            "httpOnly": false,
            "sameSite": Value::Null,
            "expires": 0,
            "created": 1500000,
        });
        let entries = json!([["A", [c]]]).to_string();
        let out = arr(&merge_ns_js("default", &entries, "import-wins"));
        assert_eq!(out["jars"], 1);
        assert_eq!(out["cookies"], 0);
        assert_eq!(out["conflicts"], 1);
        let d = arr(&match_document_js(
            "default",
            "https://a.example.com/",
            LATER,
        ));
        assert_eq!(d[0]["value"], "new");
    }

    #[test]
    fn remove_identities_count() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1"]),
            false,
            NOW,
        );
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["j=1"]),
            false,
            NOW,
        );
        let ids = json!([{"name": "k", "domain": "a.example.com", "hostOnly": true, "path": "/"}])
            .to_string();
        assert_eq!(remove_identities_js("default", &ids), 1);
        let d = arr(&match_document_js(
            "default",
            "https://a.example.com/",
            LATER,
        ));
        assert_eq!(d.as_array().map(Vec::len), Some(1));
        assert_eq!(d[0]["name"], "j");
    }

    #[test]
    fn export_all_and_clear_all() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=1"]),
            false,
            NOW,
        );
        store_batch(
            "client:c1",
            "B",
            "https://b.example.com/",
            &headers(&["j=1"]),
            false,
            NOW,
        );
        let all = arr(&export_all_js());
        assert_eq!(all["default"].as_array().map(Vec::len), Some(1));
        assert_eq!(all["client:c1"].as_array().map(Vec::len), Some(1));
        clear_all_js();
        assert_eq!(export_all_js(), "{}");
    }

    #[test]
    fn keep_existing_counts_conflict_without_replacing() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["k=old"]),
            false,
            NOW,
        );
        let c = json!({
            "name": "k",
            "value": "new",
            "domain": "a.example.com",
            "hostOnly": true,
            "path": "/",
            "secure": false,
            "httpOnly": false,
            "sameSite": Value::Null,
            "expires": 0,
            "created": 1500000,
        });
        let entries = json!([["A", [c]]]).to_string();
        let out = arr(&merge_ns_js("default", &entries, "keep-existing"));
        assert_eq!(out["jars"], 1);
        assert_eq!(out["cookies"], 0);
        assert_eq!(out["conflicts"], 1);
        let d = arr(&match_document_js(
            "default",
            "https://a.example.com/",
            LATER,
        ));
        assert_eq!(d[0]["value"], "old");
    }

    #[test]
    fn malformed_headers_report_empty_name() {
        let out = store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["novalue", "=v"]),
            false,
            NOW,
        );
        let o = arr(&out);
        assert_eq!(o[0]["name"], "");
        assert_eq!(o[0]["rejected"], "malformed");
        assert_eq!(o[1]["name"], "");
        assert_eq!(o[1]["rejected"], "malformed");
    }

    #[test]
    fn sweep_reports_expired() {
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["dead=1; Max-Age=1"]),
            false,
            NOW,
        );
        store_batch(
            "default",
            "A",
            "https://a.example.com/",
            &headers(&["live=1"]),
            false,
            NOW,
        );
        let removed = arr(&sweep_js("default", LATER));
        assert_eq!(removed.as_array().map(Vec::len), Some(1));
        assert_eq!(removed[0]["name"], "dead");
    }
}
