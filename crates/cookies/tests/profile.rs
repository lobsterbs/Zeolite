//! Cross-bucket jar-profile semantics, ported from the TS seams
//! (cookies.ts): identity, replacement and per-domain capacity
//! counting span buckets exactly like the engine's jar map. The
//! flat-jar torture suite (tests/torture.rs) covers the pure
//! semantics; this file pins the bucketed behaviors the wasm
//! registry ships, including the sibling-duplicate collapse the
//! TS seams perform over pre-fix admissions and imports.

use zeolite_cookies::jar::{Cookie, Reject, StoreOutcome};
use zeolite_cookies::profile::{CookieIdentity, MergeRule, Profile};
use zeolite_cookies::url::parse_http_url;

const NOW: i64 = 1_000_000;
const LATER: i64 = 2_000_000;

fn never_psl(_d: &str) -> bool {
    false
}

fn origin(u: &str) -> zeolite_cookies::url::Origin {
    parse_http_url(u).unwrap()
}

fn found(outcome: &StoreOutcome) -> bool {
    matches!(outcome, StoreOutcome::Stored { .. })
}

fn rejected(outcome: &StoreOutcome) -> &Reject {
    match outcome {
        StoreOutcome::Rejected(r) => r,
        _ => panic!("expected a rejection"),
    }
}

/* A host-only cookie template for the a.example origin. */
fn host_cookie(name: &str, value: &str, created: i64) -> Cookie {
    Cookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: "a.example.com".to_string(),
        host_only: true,
        path: "/".to_string(),
        secure: false,
        http_only: false,
        same_site: None,
        expires: 0,
        created,
    }
}

/* A Domain=example cookie template (session, path /). */
fn domain_cookie(name: &str, value: &str, created: i64) -> Cookie {
    Cookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: "example.com".to_string(),
        host_only: false,
        path: "/".to_string(),
        secure: false,
        http_only: false,
        same_site: None,
        expires: 0,
        created,
    }
}

fn count_named(p: &Profile, name: &str) -> usize {
    let mut n = 0;
    for (_, list) in p.buckets() {
        for c in list {
            if c.name == name {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn stores_into_bucket_and_matches_across_buckets() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/dir/page");
    assert!(found(&p.store(
        "A",
        &o,
        "k=1; Domain=example.com; Path=/",
        false,
        NOW,
        never_psl
    )));
    let req = origin("https://b.example.com/other");
    let (matched, purged) = p.match_request(&req, LATER);
    assert!(purged.is_empty());
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].name, "k");
    assert_eq!(matched[0].domain, "example.com");
    assert!(!matched[0].host_only);
}

#[test]
fn host_only_cookie_never_crosses_hosts() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "k=1", false, NOW, never_psl)));
    let req = origin("https://b.example.com/");
    let (matched, _) = p.match_request(&req, LATER);
    assert!(matched.is_empty());
    let same = origin("https://a.example.com/x");
    let (matched, _) = p.match_request(&same, LATER);
    assert_eq!(matched.len(), 1);
}

#[test]
fn deletion_retires_the_identity_from_sibling_buckets() {
    /* Duplicate identity copies in sibling buckets arise from
    pre-fix admissions and imports; a deletion must retire every
    copy and report the earliest-created one. */
    let mut p = Profile::new();
    p.set_bucket("A", vec![domain_cookie("k", "1", NOW)]);
    p.set_bucket("B", vec![domain_cookie("k", "2", NOW + 100)]);
    let o = origin("https://a.example.com/");
    let out = p.store(
        "B",
        &o,
        "k=; Domain=example.com; Path=/; Max-Age=0",
        false,
        3 * LATER,
        never_psl,
    );
    match out {
        StoreOutcome::Deleted { cookie } => {
            let removed = cookie.expect("a copy must be reported");
            assert_eq!(removed.value, "1");
            assert_eq!(removed.created, NOW);
        }
        other => panic!("expected deletion, got {:?}", other),
    }
    let (matched, purged) = p.match_request(&o, 3 * LATER);
    assert!(matched.is_empty());
    assert!(purged.is_empty());
    assert_eq!(count_named(&p, "k"), 0);
}

#[test]
fn script_writes_never_touch_httponly_identities() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store(
        "A",
        &o,
        "k=1; HttpOnly",
        false,
        NOW,
        never_psl
    )));
    /* #337: a document.cookie deletion of an HttpOnly identity is
    a silent no-op, never a rejection. */
    assert_eq!(
        p.store("A", &o, "k=; Max-Age=0", true, LATER, never_psl),
        StoreOutcome::Noop
    );
    /* A document.cookie replacement over an HttpOnly identity is
    refused. */
    assert_eq!(
        *rejected(&p.store("A", &o, "k=2", true, LATER, never_psl)),
        Reject::HttpOnlyScriptWrite
    );
    /* The HttpOnly cookie survived both script attempts. */
    let mut survived: Vec<String> = Vec::new();
    for (_, list) in p.buckets() {
        for c in list {
            if c.name == "k" {
                survived.push(c.value.clone());
            }
        }
    }
    assert_eq!(survived, vec!["1".to_string()]);
    /* Only a server response retires it. */
    assert!(matches!(
        p.store("A", &o, "k=; Max-Age=0", false, 3 * LATER, never_psl),
        StoreOutcome::Deleted { .. }
    ));
}

#[test]
fn deletion_noop_when_identity_absent() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert_eq!(
        p.store("A", &o, "k=; Max-Age=0", false, NOW, never_psl),
        StoreOutcome::Noop
    );
}

#[test]
fn replacement_collapses_sibling_duplicates_into_canonical_home() {
    let mut p = Profile::new();
    p.set_bucket("A", vec![domain_cookie("k", "1", NOW)]);
    p.set_bucket("B", vec![domain_cookie("k", "2", NOW + 500)]);
    let o = origin("https://a.example.com/");
    let out = p.store(
        "B",
        &o,
        "k=3; Domain=example.com; Path=/",
        false,
        LATER,
        never_psl,
    );
    match out {
        StoreOutcome::Stored {
            cookie, replaced, ..
        } => {
            assert!(replaced);
            assert_eq!(cookie.value, "3");
            assert_eq!(cookie.created, NOW, "5.3.11: creation time is kept");
        }
        other => panic!("expected stored, got {:?}", other),
    }
    /* The canonical home is the earliest-created copy's bucket; the
    sibling duplicate collapsed. */
    let mut homes: Vec<String> = Vec::new();
    for (key, list) in p.buckets() {
        for c in list {
            if c.name == "k" {
                homes.push(key.clone());
            }
        }
    }
    assert_eq!(homes, vec!["A".to_string()]);
}

#[test]
fn new_identity_lands_in_the_response_bucket() {
    let mut p = Profile::new();
    let a = origin("https://a.example.com/");
    let b = origin("https://b.example.com/");
    assert!(found(&p.store("A", &a, "k=1", false, NOW, never_psl)));
    assert!(found(&p.store("B", &b, "j=1", false, LATER, never_psl)));
    let mut names_a: Vec<String> = Vec::new();
    let mut names_b: Vec<String> = Vec::new();
    for (key, list) in p.buckets() {
        for c in list {
            if key == "A" {
                names_a.push(c.name.clone());
            } else if key == "B" {
                names_b.push(c.name.clone());
            }
        }
    }
    assert_eq!(names_a, vec!["k".to_string()]);
    assert_eq!(names_b, vec!["j".to_string()]);
}

#[test]
fn sweep_counts_per_domain_across_buckets() {
    let mut p = Profile::new();
    let a = origin("https://a.example.com/");
    let b = origin("https://b.example.com/");
    /* 50 live Domain=example cookies across two buckets. */
    /* 50 distinct identities spread across two buckets: the same
    name stored twice would replace and collapse, not duplicate. */
    for i in 0..50 {
        let h = format!("k{}=v; Domain=example.com; Path=/", i);
        if i % 2 == 0 {
            assert!(found(&p.store("A", &a, &h, false, NOW, never_psl)));
        } else {
            assert!(found(&p.store("B", &b, &h, false, NOW, never_psl)));
        }
    }
    /* The 51st, expiring soonest, must be evicted cross-bucket. */
    assert!(found(&p.store(
        "B",
        &b,
        "extra=1; Domain=example.com; Path=/; Max-Age=1",
        false,
        NOW,
        never_psl
    )));
    let removed = p.sweep(None, NOW + 500);
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].name, "extra");
    let mut left = 0;
    for (_, list) in p.buckets() {
        left += list.len();
    }
    assert_eq!(left, 50);
}

#[test]
fn sweep_drops_expired_first() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store(
        "A",
        &o,
        "dead=1; Max-Age=1",
        false,
        NOW,
        never_psl
    )));
    let removed = p.sweep(None, NOW + 2000);
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].name, "dead");
}

#[test]
fn sweep_protects_the_fresh_identity() {
    let mut p = Profile::new();
    let a = origin("https://a.example.com/");
    let b = origin("https://b.example.com/");
    /* 50 distinct identities spread across two buckets: the same
    name stored twice would replace and collapse, not duplicate. */
    for i in 0..50 {
        let h = format!("k{}=v; Domain=example.com; Path=/", i);
        if i % 2 == 0 {
            assert!(found(&p.store("A", &a, &h, false, NOW, never_psl)));
        } else {
            assert!(found(&p.store("B", &b, &h, false, NOW, never_psl)));
        }
    }
    let out = p.store(
        "B",
        &b,
        "extra=1; Domain=example.com; Path=/; Max-Age=1",
        false,
        NOW,
        never_psl,
    );
    let fresh = match out {
        StoreOutcome::Stored { cookie, .. } => cookie,
        other => panic!("expected stored, got {:?}", other),
    };
    let removed = p.sweep(Some(&fresh), NOW + 500);
    /* The fresh cookie is protected even though it expires
    soonest; a session cookie pays the domain excess instead. */
    assert_eq!(removed.len(), 1);
    assert_ne!(removed[0].name, "extra");
    assert_eq!(count_named(&p, "extra"), 1);
}

#[test]
fn total_cap_counts_across_buckets() {
    let mut p = Profile::new();
    /* 61 buckets x 50 distinct-domain cookies = 3050 live, past
    the 3000 total cap with no per-domain excess. */
    for i in 0..61 {
        let mut cookies: Vec<Cookie> = Vec::new();
        for j in 0..50 {
            cookies.push(Cookie {
                name: format!("k{}", j),
                value: "v".to_string(),
                domain: format!("d{}.example", i),
                host_only: true,
                path: "/".to_string(),
                secure: false,
                http_only: false,
                same_site: None,
                expires: 0,
                created: NOW + i as i64,
            });
        }
        p.set_bucket(&format!("B{}", i), cookies);
    }
    let removed = p.sweep(None, LATER);
    /* Eviction is by expiry then creation: the earliest-created
    bucket, B0, pays the whole excess. */
    assert_eq!(removed.len(), 50);
    assert!(removed.iter().all(|c| c.domain == "d0.example"));
    let mut left = 0;
    for (_, list) in p.buckets() {
        left += list.len();
    }
    assert_eq!(left, 3000);
}

#[test]
fn match_request_purges_expired_and_reports_them() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "live=1", false, NOW, never_psl)));
    assert!(found(&p.store(
        "A",
        &o,
        "dead=1; Max-Age=1",
        false,
        NOW,
        never_psl
    )));
    let req = origin("https://a.example.com/");
    let (matched, purged) = p.match_request(&req, NOW + 2000);
    assert_eq!(purged.len(), 1);
    assert_eq!(purged[0].name, "dead");
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].name, "live");
    /* The purge stuck. */
    let (_, purged2) = p.match_request(&req, NOW + 2001);
    assert!(purged2.is_empty());
}

#[test]
fn match_document_skips_httponly_and_expired() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "vis=1", false, NOW, never_psl)));
    assert!(found(&p.store(
        "A",
        &o,
        "hid=1; HttpOnly",
        false,
        NOW,
        never_psl
    )));
    assert!(found(&p.store(
        "A",
        &o,
        "dead=1; Max-Age=1",
        false,
        NOW,
        never_psl
    )));
    let page = origin("https://a.example.com/");
    let matched = p.match_document(&page, NOW + 2000);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].name, "vis");
}

#[test]
fn secure_storage_admits_loopback_but_attach_never_does() {
    let mut p = Profile::new();
    let o = origin("http://a.example/");
    let out = p.store("A", &o, "k=1; Secure", false, NOW, never_psl);
    assert_eq!(*rejected(&out), Reject::SecureFromInsecureOrigin);
    /* Loopback admits Secure cookies, but attach still needs a
    secure request (pinned #191 deviation). */
    let lo = origin("http://localhost/");
    assert!(found(&p.store(
        "L",
        &lo,
        "k=1; Secure",
        false,
        NOW,
        never_psl
    )));
    let (matched, _) = p.match_request(&lo, LATER);
    assert!(matched.is_empty());
    let los = origin("https://localhost/x");
    let (matched, _) = p.match_request(&los, LATER);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].name, "k");
}

#[test]
fn domain_gate_rejects_foreign_and_public_suffix_domains() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    let out = p.store("A", &o, "k=1; Domain=other.com", false, NOW, never_psl);
    assert_eq!(*rejected(&out), Reject::Domain);
    let out = p.store("A", &o, "k=1; Domain=com", false, NOW, |d: &str| d == "com");
    assert_eq!(*rejected(&out), Reject::Domain);
}

#[test]
fn remove_identities_spans_buckets() {
    let mut p = Profile::new();
    p.set_bucket("A", vec![domain_cookie("k", "1", NOW)]);
    p.set_bucket("B", vec![domain_cookie("k", "2", NOW + 100)]);
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "j=1", false, NOW, never_psl)));
    let removed = p.remove_identities(&[CookieIdentity {
        name: "k".to_string(),
        domain: "example.com".to_string(),
        host_only: false,
        path: "/".to_string(),
    }]);
    assert_eq!(removed, 2);
    let matched = p.match_document(&o, LATER);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].name, "j");
}

#[test]
fn merge_import_wins_replaces_wholesale() {
    /* TS jarMerge parity: import-wins stores the import record
    wholesale, creation time included. */
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "k=old", false, NOW, never_psl)));
    let incoming = host_cookie("k", "new", LATER);
    let entries = vec![("A".to_string(), vec![incoming])];
    let (jars, cookies, conflicts) = p.merge(&entries, MergeRule::ImportWins);
    assert_eq!((jars, cookies, conflicts), (1, 0, 1));
    let page = origin("https://a.example.com/");
    let matched = p.match_document(&page, 3 * LATER);
    assert_eq!(matched[0].value, "new");
    assert_eq!(matched[0].created, LATER);
}

#[test]
fn merge_keep_newest_loses_to_an_older_import() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "k=old", false, NOW, never_psl)));
    let incoming = host_cookie("k", "stale", NOW - 100);
    let entries = vec![("A".to_string(), vec![incoming])];
    let (_, _, conflicts) = p.merge(&entries, MergeRule::KeepNewest);
    assert_eq!(conflicts, 1);
    let page = origin("https://a.example.com/");
    let matched = p.match_document(&page, LATER);
    assert_eq!(matched[0].value, "old");
    assert_eq!(matched[0].created, NOW);
}

#[test]
fn set_clear_and_clear_bucket_roundtrip() {
    let mut p = Profile::new();
    let o = origin("https://a.example.com/");
    assert!(found(&p.store("A", &o, "k=1", false, NOW, never_psl)));
    assert_eq!(p.clear_bucket("A"), 1);
    assert_eq!(p.clear_bucket("A"), 0);
    assert!(found(&p.store("A", &o, "k=1", false, NOW, never_psl)));
    assert_eq!(p.clear(), (1, 1));
    assert_eq!(p.clear(), (0, 0));
}
