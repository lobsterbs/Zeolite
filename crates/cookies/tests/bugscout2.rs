//! Bug-scout #2 probes (#667): five RFC 6265/bis defects found by a
//! second spec sweep, pinned at the pure-semantics layer with the
//! spec-true expectation. The TS arm pins the same behaviors in
//! app/src/__tests__/cookies-bugscout2.test.ts.
//!
//! 1. RFC 6265 5.1.1 steps 3-4 window the year-VALUE, not the token
//!    length: "0069" is the year 69 -> 2069, "0070" -> 1970.
//! 2. bis 5.6 steps 7+10: a Domain value that is empty after the one
//!    leading-dot strip is an empty domain-attribute -> host-only.
//! 3. bis Cookie Lifetime Limits / Expires step 4 / Max-Age step 6:
//!    a lifetime longer than 400 days (34560000 seconds) is reduced
//!    to the limit; deletions are unaffected.
//! 4. bis 5.6 step 16 (leave secure cookies alone): a non-Secure
//!    cookie received over a non-secure connection aborts when it
//!    would shadow an existing Secure cookie of the same name.
//! 5. bis 5.6 step 9: a public-suffix Domain equal to the host
//!    degrades to host-only instead of aborting.

use zeolite_cookies::{parse_cookie_date, parse_http_url, Jar, Origin, Profile, Reject, StoreOutcome};

const NOW: i64 = 1_735_689_600_000; // 2025-01-01T00:00:00Z
const AGE_LIMIT_MS: i64 = 34_560_000 * 1000;

const NO_PS: fn(&str) -> bool = |_| false;
const GITHUB_IO_PS: fn(&str) -> bool = |d: &str| d == "github.io";

fn org(u: &str) -> Origin {
    parse_http_url(u).unwrap()
}

/* 1. year windowing -------------------------------------------------- */

#[test]
fn zero_padded_years_window_by_value() {
    assert_eq!(
        parse_cookie_date("Wed, 09 Jun 069 10:18:14 GMT"),
        Some(3_137_998_694_000)
    ); // 2069-06-09T10:18:14Z
    assert_eq!(
        parse_cookie_date("Wed, 09 Jun 0069 10:18:14 GMT"),
        Some(3_137_998_694_000)
    );
    assert_eq!(parse_cookie_date("Thu, 01 Jan 0070 00:00:00 GMT"), Some(0));
    assert_eq!(
        parse_cookie_date("Wed, 09 Jun 0099 10:18:14 GMT"),
        Some(928_923_494_000)
    ); // 1999-06-09T10:18:14Z
}

#[test]
fn years_outside_the_windows_still_fail_closed() {
    assert_eq!(parse_cookie_date("Wed, 09 Jun 999 10:18:14 GMT"), None);
    assert_eq!(parse_cookie_date("Wed, 09 Jun 1500 10:18:14 GMT"), None);
    assert_eq!(parse_cookie_date("Sun, 32 Jun 2021 10:18:14 GMT"), None);
    assert_eq!(parse_cookie_date("Sun, 99 Jun 2021 10:18:14 GMT"), None);
    assert_eq!(parse_cookie_date("Wed, 09 Jun 2021 10:18:60 GMT"), None);
}

/* 2. Domain=. degrades to host-only ---------------------------------- */

#[test]
fn domain_dot_is_an_empty_domain_attribute_host_only() {
    let mut jar = Jar::new();
    let out = jar.store(&org("https://accounts.example.com/"), "k=1; Domain=.", false, NOW, NO_PS);
    match &out {
        StoreOutcome::Stored { cookie, .. } => {
            assert!(cookie.host_only);
            assert_eq!(cookie.domain, "accounts.example.com");
        }
        other => panic!("expected Stored, got {:?}", other),
    }
    assert!(jar.header_for(&org("https://accounts.example.com/"), NOW).is_some());
    assert!(jar.header_for(&org("https://x.accounts.example.com/"), NOW).is_none());
}

#[test]
fn domain_dot_profile_arm_matches() {
    let mut p = Profile::new();
    let out = p.store(
        "b1",
        &org("https://accounts.example.com/"),
        "k=1; Domain=.",
        false,
        NOW,
        NO_PS,
    );
    match &out {
        StoreOutcome::Stored { cookie, .. } => assert!(cookie.host_only),
        other => panic!("expected Stored, got {:?}", other),
    }
    assert!(p.match_document(&org("https://x.accounts.example.com/"), NOW).is_empty());
}

#[test]
fn multi_dot_domain_still_fails_the_gate() {
    let mut jar = Jar::new();
    let out = jar.store(&org("https://accounts.example.com/"), "k=1; Domain=..", false, NOW, NO_PS);
    assert_eq!(out, StoreOutcome::Rejected(Reject::Domain));
}

/* 3. 400-day lifetime cap --------------------------------------------- */

#[test]
fn age_limit_caps_max_age_and_expires() {
    let mut jar = Jar::new();
    let out = jar.store(&org("https://a.example/"), "k=1; Max-Age=34600000", false, NOW, NO_PS);
    match &out {
        StoreOutcome::Stored { cookie, .. } => assert_eq!(cookie.expires, NOW + AGE_LIMIT_MS),
        other => panic!("expected Stored, got {:?}", other),
    }
    let absurd = "k=1; Max-Age=".to_string() + &"9".repeat(320);
    let out = jar.store(&org("https://a.example/"), &absurd, false, NOW, NO_PS);
    match &out {
        StoreOutcome::Stored { cookie, .. } => {
            assert_eq!(cookie.expires, NOW + AGE_LIMIT_MS);
        }
        other => panic!("expected Stored, got {:?}", other),
    }
    let out = jar.store(
        &org("https://a.example/"),
        "k=1; Expires=Wed, 09 Jun 9999 10:18:14 GMT",
        false,
        NOW,
        NO_PS,
    );
    match &out {
        StoreOutcome::Stored { cookie, .. } => assert_eq!(cookie.expires, NOW + AGE_LIMIT_MS),
        other => panic!("expected Stored, got {:?}", other),
    }
}

#[test]
fn age_limit_leaves_under_cap_and_deletions_untouched() {
    let mut jar = Jar::new();
    let out = jar.store(&org("https://a.example/"), "k=1; Max-Age=34559999", false, NOW, NO_PS);
    match &out {
        StoreOutcome::Stored { cookie, .. } => assert_eq!(cookie.expires, NOW + 34_559_999_000),
        other => panic!("expected Stored, got {:?}", other),
    }
    let out = jar.store(&org("https://a.example/"), "k=1; Max-Age=0", false, NOW, NO_PS);
    assert!(matches!(out, StoreOutcome::Deleted { cookie: Some(_) }));
}

/* 4. leave secure cookies alone ---------------------------------------- */

#[test]
fn http_cannot_overwrite_or_delete_a_secure_cookie() {
    let mut jar = Jar::new();
    jar.store(&org("https://example.com/"), "sid=1; Secure; Path=/", false, NOW, NO_PS);
    let out = jar.store(&org("http://example.com/"), "sid=2; Path=/", false, NOW, NO_PS);
    assert_eq!(out, StoreOutcome::Rejected(Reject::SecureShadow));
    assert_eq!(jar.header_for(&org("https://example.com/"), NOW).as_deref(), Some("sid=1"));
    let out = jar.store(&org("http://example.com/"), "sid=1; Path=/; Max-Age=0", false, NOW, NO_PS);
    assert_eq!(out, StoreOutcome::Rejected(Reject::SecureShadow));
    assert_eq!(jar.header_for(&org("https://example.com/"), NOW).as_deref(), Some("sid=1"));
}

#[test]
fn shadow_domain_comparison_runs_both_directions() {
    let mut p = Profile::new();
    p.store(
        "b1",
        &org("https://sub.example.com/"),
        "sid=1; Secure; Domain=example.com; Path=/",
        false,
        NOW,
        NO_PS,
    );
    let out = p.store(
        "b2",
        &org("http://other.example.com/"),
        "sid=2; Domain=example.com; Path=/",
        false,
        NOW,
        NO_PS,
    );
    assert_eq!(out, StoreOutcome::Rejected(Reject::SecureShadow));
}

#[test]
fn shadow_path_comparison_is_bis_directional() {
    let mut jar = Jar::new();
    jar.store(&org("https://example.com/"), "tok=1; Secure; Path=/", false, NOW, NO_PS);
    /* the new path path-matches the secure cookie's path -> blocked */
    let out = jar.store(&org("http://example.com/"), "tok=2; Path=/deep", false, NOW, NO_PS);
    assert_eq!(out, StoreOutcome::Rejected(Reject::SecureShadow));
    /* a non-overlapping narrower scope stays writable */
    let mut jar = Jar::new();
    jar.store(&org("https://example.com/"), "tok=1; Secure; Path=/deep", false, NOW, NO_PS);
    let out = jar.store(&org("http://example.com/"), "tok=2; Path=/", false, NOW, NO_PS);
    assert!(matches!(out, StoreOutcome::Stored { .. }));
}

#[test]
fn secure_writers_and_loopback_keep_full_power() {
    let mut jar = Jar::new();
    jar.store(&org("https://example.com/"), "sid=1; Secure; Path=/", false, NOW, NO_PS);
    let out = jar.store(&org("https://example.com/"), "sid=2; Path=/", false, NOW, NO_PS);
    assert!(matches!(out, StoreOutcome::Stored { .. }));
    assert_eq!(jar.header_for(&org("https://example.com/"), NOW).as_deref(), Some("sid=2"));
    /* the #191 loopback grant is a secure connection for step 16 */
    let mut jar = Jar::new();
    jar.store(&org("http://localhost/"), "sid=1; Secure; Path=/", false, NOW, NO_PS);
    let out = jar.store(&org("http://localhost/"), "sid=2; Path=/", false, NOW, NO_PS);
    assert!(matches!(out, StoreOutcome::Stored { .. }));
}

/* 5. public-suffix Domain equal to the host ----------------------------- */

#[test]
fn psl_domain_equal_to_host_degrades_to_host_only() {
    let mut jar = Jar::new();
    let out = jar.store(&org("https://github.io/"), "k=1; Domain=github.io", false, NOW, GITHUB_IO_PS);
    match &out {
        StoreOutcome::Stored { cookie, .. } => {
            assert!(cookie.host_only);
            assert_eq!(cookie.domain, "github.io");
        }
        other => panic!("expected Stored, got {:?}", other),
    }
    assert_eq!(jar.header_for(&org("https://github.io/"), NOW).as_deref(), Some("k=1"));
    /* a public-suffix Domain from a subdomain still aborts */
    let out = jar.store(&org("https://sub.github.io/"), "k=1; Domain=github.io", false, NOW, GITHUB_IO_PS);
    assert_eq!(out, StoreOutcome::Rejected(Reject::Domain));
}
