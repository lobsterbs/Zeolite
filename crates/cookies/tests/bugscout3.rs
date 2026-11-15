//! Bug-scout #3 probes (#670): the restore/clear seams, pinned at
//! the bucketed profile layer with the honest behavior. The TS arm
//! pins the same behaviors in cookies-bugscout3.test.ts.
//!
//! 1. zl:clearJar(origin) must span buckets (#337/#49 class): a
//!    Domain cookie set by a sibling origin lives in the SIBLING's
//!    bucket while still attaching to the cleared host.
//! 2. Restored and imported records are content-gated: a control
//!    character in any stored string would re-open the #349
//!    poisoned-Cookie-header class from inside the store.

use zeolite_cookies::{parse_http_url, Cookie, MergeRule, Origin, Profile, SameSite};

const NOW: i64 = 1_735_689_600_000;

const NO_PS: fn(&str) -> bool = |_| false;

fn org(u: &str) -> Origin {
    parse_http_url(u).unwrap()
}

#[test]
fn clear_scoped_spans_buckets_like_identity_removal() {
    let mut p = Profile::new();
    p.store(
        "sub",
        &org("https://sub.example.com/"),
        "sid=1; Domain=example.com; Path=/",
        false,
        NOW,
        NO_PS,
    );
    p.store(
        "apex",
        &org("https://example.com/"),
        "own=2",
        false,
        NOW,
        NO_PS,
    );
    p.store(
        "sub",
        &org("https://sub.example.com/"),
        "sub=3",
        false,
        NOW,
        NO_PS,
    );
    p.store(
        "sub",
        &org("https://sub.example.com/"),
        "dsc=5; Domain=sub.example.com; Path=/",
        false,
        NOW,
        NO_PS,
    );
    let (jars, cookies) = p.clear_scoped("example.com");
    /* two buckets lost cookies: the sibling-stored Domain cookie and
    the apex's own host-only one */
    assert_eq!((jars, cookies), (2, 2));
    assert!(p
        .match_document(&org("https://example.com/"), NOW)
        .is_empty());
    /* record-level semantics: the Domain cookie is gone everywhere;
    scopes that do not apply to the cleared host survive */
    let live = p.match_document(&org("https://sub.example.com/"), NOW);
    let names: Vec<&str> = live.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["sub", "dsc"]);
}

#[test]
fn clear_scoped_keeps_unrelated_scopes_and_is_honest_when_empty() {
    let mut p = Profile::new();
    p.store(
        "sub",
        &org("https://sub.example.com/"),
        "sub=3",
        false,
        NOW,
        NO_PS,
    );
    let (jars, cookies) = p.clear_scoped("example.com");
    assert_eq!((jars, cookies), (0, 0));
    assert_eq!(
        p.match_document(&org("https://sub.example.com/"), NOW)
            .len(),
        1
    );
}

/* The content gate for imported records lives at the JSON seam
(cookies-wasm cookie_from_json, the same boundary the TS
isStoredCookie owns on the other arm): Profile::merge trusts its
caller by contract, so the poisoned-record probe is pinned in the
cookies-wasm test module, not here. */

#[test]
fn clean_imports_keep_their_same_site_field() {
    let mut p = Profile::new();
    let c = Cookie {
        name: "ss".to_string(),
        value: "1".to_string(),
        domain: "a.example".to_string(),
        host_only: true,
        path: "/".to_string(),
        secure: true,
        http_only: false,
        same_site: Some(SameSite::None),
        expires: 0,
        created: NOW,
    };
    p.merge(&[("A".to_string(), vec![c])], MergeRule::ImportWins);
    let live = p.match_document(&org("https://a.example/"), NOW);
    assert_eq!(live[0].same_site, Some(SameSite::None));
}
