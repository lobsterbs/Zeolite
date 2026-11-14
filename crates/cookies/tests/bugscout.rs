//! Bug-scout tests for the #614 cookie jar (this file pins each
//! found defect with the spec-true expectation before the fix).
//!
//! 1. loopback secure-origin gate over-matches: any host whose
//!    FIRST dotted label is "127" (e.g. 127.0.0.1.evil.com) was
//!    treated as loopback, so an attacker-controlled name could
//!    set Secure cookies over http. Real loopback is localhost,
//!    *.localhost, 127/8 dotted quads and [::1] only.
//! 2. the 6265bis name prefixes are CASE-INSENSITIVE; the gate
//!    compared case-sensitively, so "__secure-k" without Secure
//!    was admitted.
//! 3. Profile::sweep computed the 6.1 total excess over the set
//!    BEFORE the per-domain evictions were applied, over-evicting
//!    (and double-reporting) whenever an import/restore landed
//!    over both limits at once.
//! 4. Domain/Path attribute values carrying control characters
//!    were stored into the jar; an attribute value outside the
//!    5.2 grammar is ignored, not ingested.

use zeolite_cookies::{
    parse_http_url, parse_set_cookie, Cookie, Jar, Origin, Profile, Reject, StoreOutcome,
    COOKIE_MAX_PER_DOMAIN, COOKIE_MAX_TOTAL,
};

const NOW: i64 = 1_735_689_600_000;
const NO_PS: fn(&str) -> bool = |_| false;

fn org(u: &str) -> Origin {
    parse_http_url(u).unwrap()
}

fn store(jar: &mut Jar, u: &str, header: &str) -> StoreOutcome {
    jar.store(&org(u), header, false, NOW, NO_PS)
}

fn rejected(o: StoreOutcome) -> Reject {
    match o {
        StoreOutcome::Rejected(r) => r,
        other => panic!("expected Rejected, got {:?}", other),
    }
}

fn sc(name: &str, value: &str, domain: &str, created: i64) -> Cookie {
    Cookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: domain.to_string(),
        host_only: false,
        path: "/".to_string(),
        secure: false,
        http_only: false,
        same_site: None,
        expires: 0,
        created,
    }
}

/* ---- 1. the loopback secure-origin gate ---- */

#[test]
fn loopback_secure_gate_accepts_only_real_loopback_hosts() {
    /* The real loopback set stays admitted. */
    for host in [
        "https://127.0.0.1/",
        "http://127.0.0.2/",
        "http://localhost/",
        "http://sub.localhost/",
        "http://[::1]/",
    ] {
        let mut jar = Jar::new();
        assert!(
            matches!(store(&mut jar, host, "k=1; Secure"), StoreOutcome::Stored { .. }),
            "{host} is loopback and must admit Secure cookies"
        );
    }
    /* An attacker name must not inherit the loopback grant. */
    for host in [
        "http://127.0.0.1.evil.com/",
        "http://127.example.com/",
        "http://127.0.0.1.localhost.evil.com/",
    ] {
        let mut jar = Jar::new();
        assert_eq!(
            rejected(store(&mut jar, host, "k=1; Secure")),
            Reject::SecureFromInsecureOrigin,
            "{host} is not loopback"
        );
    }
}

/* ---- 2. case-insensitive name prefixes (6265bis) ---- */

#[test]
fn secure_and_host_prefixes_match_case_insensitively() {
    let mut jar = Jar::new();
    assert_eq!(
        rejected(store(&mut jar, "http://a.example/", "__secure-k=1")),
        Reject::PrefixRequiresSecure
    );
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "__HOST-k=1; Secure; Domain=a.example")),
        Reject::HostPrefixRequiresRoot
    );
    /* A case-variant spelling that satisfies every invariant
       stores exactly like the canonical one. */
    assert!(matches!(
        store(&mut jar, "https://a.example/", "__HOST-k=1; Secure"),
        StoreOutcome::Stored { .. }
    ));
    /* Lowercase spellings that DO satisfy the invariants store. */
    assert!(matches!(
        store(&mut jar, "https://a.example/", "__host-k=1; Secure"),
        StoreOutcome::Stored { .. }
    ));
    assert!(matches!(
        store(&mut jar, "https://a.example/", "__Secure-ok=1; Secure"),
        StoreOutcome::Stored { .. }
    ));
}

/* ---- 3. Profile::sweep total-pass double-count ---- */

#[test]
fn profile_sweep_domain_pass_precedes_total_pass() {
    let mut p = Profile::new();
    /* Bucket b1: 60 session cookies on one domain (10 over the
       per-domain cap). */
    let d: Vec<Cookie> = (0..60).map(|i| sc("k", "v", "d.example", i)).collect();
    p.set_bucket("b1", d);
    /* Bucket b2: 59 domains at exactly the per-domain cap:
       2950 cookies, no per-domain excess. */
    let mut e: Vec<Cookie> = Vec::new();
    for j in 0..59usize {
        for k in 0..COOKIE_MAX_PER_DOMAIN {
            e.push(sc("k", "v", &format!("e{j}.example"), 1000 + (j * 50 + k) as i64));
        }
    }
    p.set_bucket("b2", e);

    let evicted = p.sweep(None, NOW);
    /* Total was 3010 (10 over); the domain pass evicts exactly 10
       and the total pass then sees exactly the cap: 10 unique
       evictions, 3000 cookies left, no over-eviction. */
    assert_eq!(
        evicted.len(),
        10,
        "evictions: {:?}",
        evicted.iter().map(|c| c.created).collect::<Vec<_>>()
    );
    let mut uniq = evicted.clone();
    uniq.sort_by_key(|c| c.created);
    uniq.dedup();
    assert_eq!(uniq.len(), evicted.len(), "evicted list must not double-report");
    let total: usize = p.buckets().map(|(_, v)| v.len()).sum();
    assert_eq!(total, COOKIE_MAX_TOTAL);
    let d_left = p
        .buckets()
        .flat_map(|(_, v)| v.iter())
        .filter(|c| c.domain == "d.example")
        .count();
    assert_eq!(d_left, COOKIE_MAX_PER_DOMAIN);
    /* The evicted ones are d.example's earliest-created. */
    assert!(evicted.iter().all(|c| c.domain == "d.example" && c.created < 10));
}

/* ---- 4. control characters in attribute values ---- */

#[test]
fn attribute_values_with_control_characters_are_ignored() {
    /* A CR/LF inside the Path value must not reach the jar; the
       attribute is outside the 5.2 grammar and is ignored. */
    let p = parse_set_cookie("a=1; Path=/x\r\ny").unwrap();
    assert_eq!(p.path, None);
    let d = parse_set_cookie("a=1; Domain=e\u{1d}vil.com").unwrap();
    assert_eq!(d.domain, None);
    /* Clean values still parse. */
    let ok = parse_set_cookie("a=1; Path=/x; Domain=evil.com").unwrap();
    assert_eq!(ok.path.as_deref(), Some("/x"));
    assert_eq!(ok.domain.as_deref(), Some("evil.com"));
}
