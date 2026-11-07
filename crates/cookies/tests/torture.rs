//! #614: the cookies torture suite ported from cookies-torture.mjs.
//!
//! Row-for-row port of the TS specification tests: every date
//! grammar shape, the storage-step identity semantics, expiry
//! precedence, the attach oracle, the prefix rules and the 6.1
//! eviction policy. Not ported here (they test TS machinery
//! around the jar, not the jar itself): the jar-change event
//! rows (TS notify), the persistence/IndexedDB rows (TS), the
//! zl:importSession seam rows (TS), and the tough-cookie fuzz
//! differential (needs tough-cookie in the runner). The wasm
//! wiring lands in the follow-up wave per the issue phasing.

use zeolite_cookies::{
    parse_cookie_date, parse_http_url, parse_set_cookie, Jar, Origin, Reject, SetCookie,
    StoreOutcome, COOKIE_MAX_PER_DOMAIN, COOKIE_MAX_TOTAL,
};

/// Fixed clock: 2025-01-01, inside the corpus's valid window
/// (before the 2031 future-Expires rows, after every stale one).
const NOW: i64 = 1_735_689_600_000;

const NO_PS: fn(&str) -> bool = |_| false;
fn ps(d: &str) -> bool {
    d == "co.uk" || d == "github.io"
}

fn org(u: &str) -> Origin {
    parse_http_url(u).unwrap()
}

fn store(jar: &mut Jar, u: &str, header: &str) -> StoreOutcome {
    jar.store(&org(u), header, false, NOW, NO_PS)
}

fn store_script(jar: &mut Jar, u: &str, header: &str) -> StoreOutcome {
    jar.store(&org(u), header, true, NOW, NO_PS)
}

fn stored(o: StoreOutcome) -> Cookie {
    match o {
        StoreOutcome::Stored { cookie, .. } => cookie,
        other => panic!("expected Stored, got {:?}", other),
    }
}

use zeolite_cookies::Cookie;

fn rejected(o: StoreOutcome) -> Reject {
    match o {
        StoreOutcome::Rejected(r) => r,
        other => panic!("expected Rejected, got {:?}", other),
    }
}

/* ---------------- 5.1.1 date grammar ---------------- */

/// (input, expected epoch millis). Every corpus row verified
/// against the TS parser output.
const DATE_OK: &[(&str, i64)] = &([
    ("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_777_000),
    ("Sunday, 06-Nov-94 08:49:37 GMT", 784_111_777_000),
    ("Sun Nov  6 08:49:37 1994", 784_111_777_000),
    ("Sun, 06 94 08:49:37 Nov", 784_111_777_000),
    ("07:28:00 Wed, 21 Oct 2015 GMT", 1_445_412_480_000),
    (
        "Wed, 21 Oct 2015 07:28:00 GMT extra tokens 42",
        1_445_412_480_000,
    ),
    ("Wed, 21 42 Oct 2015 07:28:00", 2_297_489_280_000),
    ("Wed, 21 Oct 42 07:28:00", 2_297_489_280_000),
    ("Wed, 21 Oct 2015 07:28:00 2015", 1_445_412_480_000),
    ("Sun, 06 Nov 1601 08:49:37 GMT", -11_617_744_223_000),
    ("Sun, 06 Nov 9999 08:49:37 GMT", 253_397_494_177_000),
    ("Wed, 21 Oct 2015 07:28 GMT", 1_445_412_480_000),
    ("Sun, 94 Nov 06 08:49:37 1994", 784_111_777_000),
    ("31 Sep 06 07:28:00", 1_159_687_680_000),
    ("Feb 30 2015 00:00:00 GMT", 1_425_254_400_000),
    ("Sun, 42 May 06 07:28:00 06", 2_282_974_080_000),
    ("07:28:00.5 Jan 9999 42", 253_371_137_280_000),
    ("SUN, 06 NOV 1994 08:49:37 GMT", 784_111_777_000),
    ("Wed, 13 Oct 68 12:00:00", 3_117_355_200_000),
    ("Wed, 13 Oct 69 12:00:00", 3_148_891_200_000),
    ("Wed, 13 Oct 70 12:00:00", 24_667_200_000),
    ("01 Jan 00 00:00:00 GMT", 946_684_800_000),
]);

const DATE_NULL: &[&str] = &[
    "2015-10-21T07:28:00Z",
    "Wed, 21 Oct 2015",
    "Sun, 06 Xxx 1994 08:49:37 GMT",
    "Sun, 06 Nov 1994 25:00:00 GMT",
    "Sun, 06 Nov 1994 08:60:00 GMT",
    "Sun, 06 Nov 1994 08:49:60 GMT",
    "Sun, 00 Nov 1994 08:49:37 GMT",
    "Sun, 32 Nov 1994 08:49:37 GMT",
    "Sun, 06 Nov 10000 08:49:37 GMT",
    "Sun, 06 Nov 1500 07:28:00 GMT",
    "not a date",
    "Wed Oct 21 2015",
    "7:8:9 Nov 2015",
    "Funday, 60 Sep 06 07:28:00",
];

#[test]
fn date_corpus_accepts() {
    for (input, want) in DATE_OK {
        assert_eq!(parse_cookie_date(input), Some(*want), "input: {}", input);
    }
}

#[test]
fn date_corpus_rejects() {
    for input in DATE_NULL {
        assert_eq!(parse_cookie_date(input), None, "input: {}", input);
    }
}

/* ---------------- identity and replacement ---------------- */

#[test]
fn identity_is_scheme_and_port_blind_but_not_host_blind() {
    let mut jar = Jar::new();
    assert!(matches!(
        store(&mut jar, "https://a.example/", "b=1"),
        StoreOutcome::Stored {
            replaced: false,
            ..
        }
    ));
    assert!(matches!(
        store(&mut jar, "http://a.example/", "b=2"),
        StoreOutcome::Stored { replaced: true, .. }
    ));
    assert!(matches!(
        store(&mut jar, "http://a.example:8080/", "b=3"),
        StoreOutcome::Stored { replaced: true, .. }
    ));
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("b=3")
    );
    /* host-only: a sibling subdomain is a different jar row. */
    assert!(matches!(
        store(&mut jar, "https://sub.a.example/", "b=4"),
        StoreOutcome::Stored {
            replaced: false,
            ..
        }
    ));
    assert_eq!(jar.cookies().len(), 2);
}

#[test]
fn domain_cookie_replaced_from_sibling_subdomains() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "d=1; Domain=a.example");
    assert!(matches!(
        store(&mut jar, "https://sub.a.example/", "d=2; Domain=a.example"),
        StoreOutcome::Stored { replaced: true, .. }
    ));
    assert_eq!(jar.cookies().len(), 1);
    assert_eq!(
        jar.header_for(&org("https://other.a.example/"), NOW)
            .as_deref(),
        Some("d=2")
    );
}

#[test]
fn deletion_via_other_scheme_kills_identity() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "z=1");
    assert!(matches!(
        store(&mut jar, "http://a.example/", "z=; Max-Age=0"),
        StoreOutcome::Deleted { .. }
    ));
    assert_eq!(jar.header_for(&org("https://a.example/"), NOW), None);
}

#[test]
fn domain_deletion_from_sibling_kills_everywhere() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "d=1; Domain=a.example");
    assert!(matches!(
        store(
            &mut jar,
            "https://sub.a.example/",
            "d=; Domain=a.example; Max-Age=0"
        ),
        StoreOutcome::Deleted { .. }
    ));
    assert_eq!(jar.header_for(&org("https://a.example/"), NOW), None);
    assert_eq!(jar.header_for(&org("https://sub.a.example/"), NOW), None);
}

#[test]
fn replacement_preserves_creation_time() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "first=1");
    store(&mut jar, "https://a.example/", "later=1");
    let first_created = jar
        .cookies()
        .iter()
        .find(|c| c.name == "first")
        .unwrap()
        .created;
    store(&mut jar, "https://a.example/", "first=2");
    let after = jar.cookies().iter().find(|c| c.name == "first").unwrap();
    assert_eq!(after.value, "2");
    assert_eq!(after.created, first_created);
    assert_eq!(jar.cookies().len(), 2);
}

#[test]
fn httponly_blocks_script_writes_not_server_writes() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "s=1; HttpOnly");
    assert_eq!(
        rejected(store_script(&mut jar, "https://a.example/", "s=2")),
        Reject::HttpOnlyScriptWrite
    );
    assert_eq!(jar.cookies()[0].value, "1");
    /* a server write replaces it fine */
    assert!(matches!(
        store(&mut jar, "https://a.example/", "s=3"),
        StoreOutcome::Stored { replaced: true, .. }
    ));
    assert_eq!(jar.cookies()[0].value, "3");
}

/* ---------------- expiry precedence ---------------- */

#[test]
fn max_age_wins_over_stale_expires() {
    let mut jar = Jar::new();
    let o = store(
        &mut jar,
        "https://a.example/",
        "a=1; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
    assert_eq!(stored(o).expires, NOW + 3_600_000);
}

#[test]
fn max_age_zero_with_future_expires_deletes() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "a=1");
    assert!(matches!(
        store(
            &mut jar,
            "https://a.example/",
            "a=; Max-Age=0; Expires=Wed, 01 Jan 2031 00:00:00 GMT"
        ),
        StoreOutcome::Deleted { .. }
    ));
    assert_eq!(jar.cookies().len(), 0);
}

#[test]
fn stale_expires_alone_deletes() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "a=1");
    assert!(matches!(
        store(
            &mut jar,
            "https://a.example/",
            "a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
        ),
        StoreOutcome::Deleted { .. }
    ));
    assert_eq!(jar.cookies().len(), 0);
}

#[test]
fn future_expires_stores() {
    let mut jar = Jar::new();
    let o = store(
        &mut jar,
        "https://a.example/",
        "a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
    );
    assert_eq!(stored(o).expires, 1_924_992_000_000);
}

/* ---------------- attach oracle ---------------- */

#[test]
fn host_only_cookies_do_not_scope_to_subdomains() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "h=1");
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("h=1")
    );
    assert_eq!(jar.header_for(&org("https://sub.a.example/"), NOW), None);
}

#[test]
fn domain_cookies_scope_across_subdomains() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "d=1; Domain=a.example");
    assert_eq!(
        jar.header_for(&org("https://sub.a.example/"), NOW)
            .as_deref(),
        Some("d=1")
    );
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("d=1")
    );
}

#[test]
fn public_suffix_domains_refused() {
    let mut jar = Jar::new();
    let o = org("https://site.co.uk/");
    assert_eq!(
        rejected(jar.store(&o, "p=1; Domain=co.uk", false, NOW, ps)),
        Reject::Domain
    );
    let o2 = org("https://user.github.io/");
    assert_eq!(
        rejected(jar.store(&o2, "p=1; Domain=github.io", false, NOW, ps)),
        Reject::Domain
    );
    assert_eq!(jar.cookies().len(), 0);
}

#[test]
fn default_path_and_path_match() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/dir/page", "a=1");
    assert_eq!(jar.cookies()[0].path, "/dir");
    assert_eq!(
        jar.header_for(&org("https://a.example/dir/other"), NOW)
            .as_deref(),
        Some("a=1")
    );
    assert_eq!(
        jar.header_for(&org("https://a.example/dir"), NOW)
            .as_deref(),
        Some("a=1")
    );
    assert_eq!(jar.header_for(&org("https://a.example/other"), NOW), None);
    assert_eq!(jar.header_for(&org("https://a.example/dirx"), NOW), None);
}

#[test]
fn longer_paths_attach_first() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/dir/page", "a=1");
    store(&mut jar, "https://a.example/dir/page", "b=1; Path=/");
    assert_eq!(
        jar.header_for(&org("https://a.example/dir/x"), NOW)
            .as_deref(),
        Some("a=1; b=1")
    );
}

#[test]
fn secure_never_attaches_over_http() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "s=1; Secure");
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("s=1")
    );
    assert_eq!(jar.header_for(&org("http://a.example/"), NOW), None);
}

#[test]
fn expired_cookies_purged_from_headers() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "a=1; Max-Age=1");
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("a=1")
    );
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW + 2_000),
        None
    );
    /* document oracle skips expired too */
    let mut jar2 = Jar::new();
    jar2.store(
        &org("https://a.example/"),
        "a=1; Max-Age=1",
        false,
        NOW,
        NO_PS,
    );
    assert_eq!(
        jar2.match_document(&org("https://a.example/"), NOW + 2_000)
            .len(),
        0
    );
}

#[test]
fn creation_order_breaks_path_ties() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "x=1");
    store(&mut jar, "https://a.example/", "y=1");
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("x=1; y=1")
    );
}

/* ---------------- prefix rules ---------------- */

#[test]
fn host_prefix_deletion_cannot_break_the_rules() {
    let mut jar = Jar::new();
    store(&mut jar, "https://a.example/", "__Host-k=1; Secure");
    /* a Domain-scoped deletion violates __Host- invariants and
    is refused: the cookie survives. */
    assert_eq!(
        rejected(store(
            &mut jar,
            "https://sub.a.example/",
            "__Host-k=; Domain=a.example; Secure; Max-Age=0"
        )),
        Reject::HostPrefixRequiresRoot
    );
    assert_eq!(
        jar.header_for(&org("https://a.example/"), NOW).as_deref(),
        Some("__Host-k=1")
    );
}

#[test]
fn prefixes_require_secure() {
    let mut jar = Jar::new();
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "__Secure-k=1")),
        Reject::PrefixRequiresSecure
    );
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "__Host-k=1")),
        Reject::PrefixRequiresSecure
    );
    assert!(matches!(
        store(&mut jar, "https://a.example/", "__Secure-k=1; Secure"),
        StoreOutcome::Stored { .. }
    ));
    assert!(matches!(
        store(&mut jar, "https://a.example/", "__Host-k=1; Secure"),
        StoreOutcome::Stored { .. }
    ));
    /* __Host- also demands host-only at root */
    assert_eq!(
        rejected(store(
            &mut jar,
            "https://a.example/",
            "__Host-k=1; Secure; Path=/x"
        )),
        Reject::HostPrefixRequiresRoot
    );
    assert_eq!(
        rejected(store(
            &mut jar,
            "https://a.example/",
            "__Host-k=1; Secure; Domain=a.example"
        )),
        Reject::HostPrefixRequiresRoot
    );
}

#[test]
fn samesite_none_without_secure_refused() {
    let mut jar = Jar::new();
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "n=1; SameSite=None")),
        Reject::SameSiteNoneWithoutSecure
    );
    assert!(matches!(
        store(&mut jar, "https://a.example/", "n=1; SameSite=None; Secure"),
        StoreOutcome::Stored { .. }
    ));
}

#[test]
fn secure_from_insecure_origin_refused() {
    let mut jar = Jar::new();
    assert_eq!(
        rejected(store(&mut jar, "http://a.example/", "s=1; Secure")),
        Reject::SecureFromInsecureOrigin
    );
    /* loopback exception, the TS engine's stance */
    assert!(matches!(
        store(&mut jar, "http://localhost:6002/", "s=1; Secure"),
        StoreOutcome::Stored { .. }
    ));
}

/* ---------------- facade boundary (#599) ---------------- */

#[test]
fn bare_parts_never_smuggle_attributes() {
    let mut jar = Jar::new();
    let sc = SetCookie::bare("k", "; Secure");
    let o = org("https://a.example/");
    assert!(matches!(
        jar.store_parsed(&o, &sc, true, NOW, NO_PS),
        StoreOutcome::Stored { .. }
    ));
    assert_eq!(jar.cookies()[0].value, "; Secure");
    assert!(!jar.cookies()[0].secure);
    /* and the parsed-header path still types the same attribute */
    let sc2 = parse_set_cookie("k=1; Secure").unwrap();
    assert!(sc2.secure);
    assert_eq!(sc2.value, "1");
}

/* ---------------- 6.1 limits and eviction (#598) ---------------- */

fn store_n(jar: &mut Jar, host: &str, n: usize, header: impl Fn(usize) -> String) {
    let o = org(&format!("https://{}/", host));
    for i in 0..n {
        jar.store(&o, &header(i), false, NOW, NO_PS);
    }
}

#[test]
fn per_domain_cap_evicts_soonest_expiry() {
    let mut jar = Jar::new();
    store_n(&mut jar, "a.example", COOKIE_MAX_PER_DOMAIN, |i| {
        /* mixed: even ids session, odd ids expiring, d1 soonest */
        if i == 1 {
            "d1=1; Max-Age=10".to_string()
        } else if i % 2 == 1 {
            format!("d{}=1; Max-Age=3600", i)
        } else {
            format!("d{}=1", i)
        }
    });
    assert_eq!(jar.cookies().len(), COOKIE_MAX_PER_DOMAIN);
    let o = org("https://a.example/");
    let out = jar.store(&o, "extra=1", false, NOW, NO_PS);
    match out {
        StoreOutcome::Stored { evicted, .. } => {
            assert_eq!(evicted.len(), 1);
            assert_eq!(evicted[0].name, "d1");
        }
        other => panic!("expected Stored, got {:?}", other),
    }
    assert_eq!(jar.cookies().len(), COOKIE_MAX_PER_DOMAIN);
    assert!(jar.cookies().iter().all(|c| c.name != "d1"));
}

#[test]
fn fresh_cookie_survives_its_own_admission() {
    let mut jar = Jar::new();
    /* fill the domain with session cookies */
    store_n(&mut jar, "a.example", COOKIE_MAX_PER_DOMAIN, |i| {
        format!("s{}=1", i)
    });
    let o = org("https://a.example/");
    /* a soonest-expiring newcomer would be the first eviction
    candidate; protection must hand the hit to the oldest
    session cookie instead. */
    let out = jar.store(&o, "keep=1; Max-Age=10", false, NOW, NO_PS);
    match out {
        StoreOutcome::Stored { evicted, .. } => {
            assert_eq!(evicted.len(), 1);
            assert_eq!(evicted[0].name, "s0");
        }
        other => panic!("expected Stored, got {:?}", other),
    }
    assert!(jar.cookies().iter().any(|c| c.name == "keep"));
}

#[test]
fn total_cap_evicts_earliest_created_overall() {
    let mut jar = Jar::new();
    /* 60 domains x 50 cookies = exactly the cap */
    for d in 0..60 {
        let host = format!("d{}.example", d);
        store_n(&mut jar, &host, COOKIE_MAX_PER_DOMAIN, |i| {
            format!("c{}=1", i)
        });
    }
    assert_eq!(jar.cookies().len(), COOKIE_MAX_TOTAL);
    /* one more store anywhere overflows the total; the earliest
    created cookie overall goes (d0.example's first). */
    let o = org("https://overflow.example/");
    let out = jar.store(&o, "over=1", false, NOW, NO_PS);
    match out {
        StoreOutcome::Stored { evicted, .. } => {
            assert_eq!(evicted.len(), 1);
            assert_eq!(evicted[0].name, "c0");
            assert_eq!(evicted[0].domain, "d0.example");
        }
        other => panic!("expected Stored, got {:?}", other),
    }
    assert_eq!(jar.cookies().len(), COOKIE_MAX_TOTAL);
    assert!(jar.cookies().iter().any(|c| c.domain == "overflow.example"));
}

#[test]
fn size_cap_in_bytes_and_deletion_exempt() {
    let mut jar = Jar::new();
    /* 4096 bytes of name+value passes, 4097 refuses */
    let ok_val = "x".repeat(4096 - 1);
    assert!(matches!(
        store(&mut jar, "https://a.example/", &format!("k={}", ok_val)),
        StoreOutcome::Stored { .. }
    ));
    let big_val = "x".repeat(4097 - 1);
    assert_eq!(
        rejected(store(
            &mut jar,
            "https://a.example/",
            &format!("k={}", big_val)
        )),
        Reject::Size
    );
    /* an oversized deletion is never size-gated */
    assert!(matches!(
        store(
            &mut jar,
            "https://a.example/",
            &format!("k=; Max-Age=0; x={}", big_val)
        ),
        StoreOutcome::Deleted { .. }
    ));
    assert_eq!(jar.cookies().len(), 0);
}

#[test]
fn duplicate_identities_collapse_on_replacement() {
    /* same identity stored twice via Domain + host trickery is
    collapsed: replacement keeps one entry per identity. */
    let mut jar = Jar::new();
    store(
        &mut jar,
        "https://a.example/",
        "a.example=1; Domain=a.example",
    );
    store(
        &mut jar,
        "https://sub.a.example/",
        "a.example=2; Domain=a.example",
    );
    assert_eq!(jar.cookies().len(), 1);
    assert_eq!(jar.cookies()[0].value, "2");
}

/* ---------------- misc gates ---------------- */

#[test]
fn malformed_and_control_character_headers_refused() {
    let mut jar = Jar::new();
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "novalue")),
        Reject::Malformed
    );
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "=v")),
        Reject::Malformed
    );
    assert_eq!(
        rejected(store(&mut jar, "https://a.example/", "a\u{0}b=1")),
        Reject::ControlCharacter
    );
    assert_eq!(jar.cookies().len(), 0);
}

#[test]
fn empty_domain_suffix_rules_hold() {
    /* a Domain that does not domain-match the host is refused */
    let mut jar = Jar::new();
    assert_eq!(
        rejected(store(
            &mut jar,
            "https://a.example/",
            "x=1; Domain=other.example"
        )),
        Reject::Domain
    );
    /* single-label Domain different from host is refused */
    assert_eq!(
        rejected(store(
            &mut jar,
            "https://a.example/",
            "x=1; Domain=intranet"
        )),
        Reject::Domain
    );
    /* but localhost-style intranet names equal to the host pass */
    let mut jar2 = Jar::new();
    assert!(matches!(
        store(&mut jar2, "http://intranet/", "x=1; Domain=intranet"),
        StoreOutcome::Stored { .. }
    ));
}
