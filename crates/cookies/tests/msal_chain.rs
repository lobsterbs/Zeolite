//! #634/#431 repro: the MSAL login redirect chain replayed through the
//! bucketed Profile (the storage layer the wasm jar drives), hop by
//! hop, the way the SW hop loop calls it:
//!
//!   store(bucket_of_response_origin, origin_of_hop, header, ...)
//!   match_request(origin_of_next_hop)
//!
//! Chain: login.microsoftonline.com/common/oauth2/v2.0/authorize -> 302
//! (Set-Cookie batch incl. cross-domain SSO cookies that must be
//! honestly rejected) -> login.live.com/Me.htm?v=3 -> 302 (Set-Cookie
//! .live.com batch) -> back to login.microsoftonline.com, which must
//! carry every cookie that scopes it.

use zeolite_cookies::profile::Profile;
use zeolite_cookies::url::parse_http_url;
use zeolite_cookies::{Reject, StoreOutcome};

fn psl(domain: &str) -> bool {
    // minimal stand-in for tldts: the public suffixes used here
    matches!(domain, "com" | "co.uk" | "net" | "org")
}

const AUTHORIZE: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20&response_type=code";
const ME_HTM: &str = "https://login.live.com/Me.htm?v=3";
const AUTHORIZE_2: &str =
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=9199bf20&sso_reload=true";

const HOP1_SETCOOKIE: [&str; 6] = [
    "ESTSSC=abc123; Domain=.login.microsoftonline.com; Path=/; Secure; SameSite=None",
    "ESTSAUTH=xyz; Domain=.login.microsoftonline.com; Path=/; Secure; HttpOnly; SameSite=Lax",
    "CCState=state1; Domain=.microsoftonline.com; Path=/; Secure",
    "LoginAttempts=1; Path=/; Secure; HttpOnly",
    // cross-domain SSO attempts: a browser rejects these too
    "SSOLive=1; Domain=.live.com; Path=/; Secure; SameSite=None",
    "SSOMs=1; Domain=.microsoft.com; Path=/; Secure",
];

const HOP2_SETCOOKIE: [&str; 4] = [
    "MSPRequ=req1; Domain=.live.com; Path=/; Secure",
    "MSPAuth=tok; Path=/; Secure; HttpOnly",
    "Profile=pf; Domain=.login.live.com; Path=/; Secure",
    // cross-domain from the live.com side: must be rejected too
    "BackToMso=1; Domain=.microsoftonline.com; Path=/; Secure",
];

fn header_for(p: &mut Profile, url: &str, now: i64) -> Option<String> {
    let o = parse_http_url(url).unwrap();
    let (matched, _purged) = p.match_request(&o, now);
    if matched.is_empty() {
        None
    } else {
        Some(
            matched
                .iter()
                .map(|c| format!("{}={}", c.name, c.value))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

#[test]
fn msal_chain_domain_scoping_across_hops() {
    let now = 1_800_000_000_000;
    let mut p = Profile::new();
    let o1 = parse_http_url(AUTHORIZE).unwrap();
    let o2 = parse_http_url(ME_HTM).unwrap();

    // hop 1: authorize answers 302 with the batch
    let mut outcomes = Vec::new();
    for h in HOP1_SETCOOKIE {
        outcomes.push(p.store("b-mso", &o1, h, false, now, psl));
    }
    let by_name = |n: &str| {
        outcomes.iter().position(|o| match o {
            StoreOutcome::Stored { cookie, .. }
            | StoreOutcome::Deleted {
                cookie: Some(cookie),
            } => cookie.name == n,
            StoreOutcome::Rejected(_) => false,
            _ => false,
        })
    };
    for n in ["ESTSSC", "ESTSAUTH", "CCState", "LoginAttempts"] {
        assert!(
            matches!(outcomes[by_name(n).unwrap()], StoreOutcome::Stored { .. }),
            "{n} must store"
        );
    }
    assert!(matches!(
        outcomes[HOP1_SETCOOKIE
            .iter()
            .position(|h| h.starts_with("SSOLive"))
            .unwrap()],
        StoreOutcome::Rejected(Reject::Domain)
    ));
    assert!(matches!(
        outcomes[HOP1_SETCOOKIE
            .iter()
            .position(|h| h.starts_with("SSOMs"))
            .unwrap()],
        StoreOutcome::Rejected(Reject::Domain)
    ));

    // hop 2 request: nothing from microsoftonline.com may reach live.com
    assert_eq!(header_for(&mut p, ME_HTM, now), None);

    // hop 2: Me.htm answers 302 with the live.com batch
    for h in HOP2_SETCOOKIE {
        let out = p.store("b-live", &o2, h, false, now, psl);
        if h.starts_with("BackToMso") {
            assert!(
                matches!(out, StoreOutcome::Rejected(Reject::Domain)),
                "cross-domain from live.com must reject"
            );
        } else {
            assert!(matches!(out, StoreOutcome::Stored { .. }), "{h} must store");
        }
    }

    // return hop: the full microsoftonline.com session rides along,
    // in 5.4 order (all paths "/", so creation order), nothing live.com
    let back = header_for(&mut p, AUTHORIZE_2, now).unwrap();
    assert_eq!(
        back,
        "ESTSSC=abc123; ESTSAUTH=xyz; CCState=state1; LoginAttempts=1"
    );
    assert!(!back.contains("MSPRequ"));
    assert!(!back.contains("MSPAuth"));

    // subdomain of microsoftonline.com is in scope for Domain=.microsoftonline.com
    let sub = header_for(&mut p, "https://device.login.microsoftonline.com/foo", now).unwrap();
    assert!(sub.contains("CCState=state1"));
    assert!(sub.contains("ESTSSC=abc123"));

    // login.microsoft.com is NOT in scope (different registrable domain)
    let other = header_for(&mut p, "https://login.microsoft.com/", now);
    assert_eq!(other, None);

    // document.cookie oracles
    let doc_me = p.match_document(&o2, now);
    let names: Vec<&str> = doc_me.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["MSPRequ", "Profile"]); // no HttpOnly MSPAuth
    let o3 = parse_http_url(AUTHORIZE_2).unwrap();
    let doc_mso_v = p.match_document(&o3, now);
    let doc_mso: Vec<&str> = doc_mso_v.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(doc_mso, ["ESTSSC", "CCState"]); // HttpOnly ESTSAUTH/LoginAttempts hidden
}
