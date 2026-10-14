//! Pinned upstream DNS for wisp destinations.
//!
//! Privacy pin: every hostname a proxied request targets is resolved
//! through the pinned public resolver, not the deployment host's
//! system resolver and never Google DNS. ZL_DNS selects the mode:
//!
//! - "quad9" (default): Quad9 anycast 9.9.9.9 + 149.112.112.112 over
//!   DNS-over-HTTPS (https://dns.quad9.net/dns-query), TLS name
//!   pinned, certificate validated against the Mozilla root store
//!   (webpki-roots): no OS trust store, no system resolver, no
//!   plaintext port 53 anywhere
//! - "cloudflare":      Cloudflare 1.1.1.1 + 1.0.0.1 over DoH
//!   (https://cloudflare-dns.com/dns-query), same pinning
//! - "system":         the host resolver via tokio::net::lookup_host
//!   (explicit operator opt-out for restricted-egress hosts; the
//!   startup log names whatever is active)
//!
//! DoH by default (#125): pinning the resolver IPs still left every
//! lookup on the wire in plaintext UDP/TCP 53, visible to the
//! deployment network and anyone on path. The same pinned IPs now
//! answer over HTTPS/443 with the resolver's certificate validated
//! against its DNS name, so the query is encrypted end to end. There
//! is deliberately no plaintext fallback: a host that blocks the DoH
//! handshake fails closed (the startup log names the mode), it never
//! silently falls back to the system resolver.
//!
//! An unrecognized ZL_DNS value logs a warning and stays on quad9;
//! it never silently falls back to the system resolver.
//!
//! Filtered-answer fallback (2026-10-14 report): the default pinned
//! endpoint, 9.9.9.9 / dns.quad9.net, is Quad9's MALWARE-BLOCKING
//! service: a flagged domain answers NXDOMAIN, which used to surface
//! as a generic UnreachableHost with no retry, so a site that loads
//! fine through a host resolver looked dead. On NXDOMAIN or SERVFAIL
//! (hickory folds the whole 5xx response-code family into one
//! no-records error) the lookup retries ONCE through the other pinned
//! provider, and only after both refuse does it fail as
//! LookupError::NotFound, its own diagnostic. The pinned-DoH
//! invariant is intact: the fallback is the other pinned public
//! resolver, never the system resolver.

use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;
use tracing::{debug, info, warn};

#[derive(Debug)]
pub enum Mode {
    Quad9,
    Cloudflare,
    System,
}

fn parse_mode(v: &str) -> Option<Mode> {
    match v.trim().to_ascii_lowercase().as_str() {
        "quad9" => Some(Mode::Quad9),
        "cloudflare" => Some(Mode::Cloudflare),
        "system" => Some(Mode::System),
        _ => None,
    }
}

static MODE: OnceLock<Mode> = OnceLock::new();

/// The active resolver mode. Read once from ZL_DNS; absent means
/// quad9. Unknown values warn and keep quad9 (fail to the private
/// default, never to the system resolver).
pub fn mode() -> &'static Mode {
    MODE.get_or_init(|| match std::env::var("ZL_DNS") {
        Err(_) => Mode::Quad9,
        Ok(raw) => match parse_mode(&raw) {
            Some(m) => m,
            None => {
                warn!("ZL_DNS={raw:?} is not quad9|cloudflare|system; staying on quad9");
                Mode::Quad9
            }
        },
    })
}

/// The other pinned provider, consulted once when the active one
/// answers NXDOMAIN/SERVFAIL. System mode has no pinned fallback.
fn fallback_mode(m: &Mode) -> Option<Mode> {
    match m {
        Mode::Quad9 => Some(Mode::Cloudflare),
        Mode::Cloudflare => Some(Mode::Quad9),
        Mode::System => None,
    }
}

/// The pinned nameserver IPs for a mode (empty for System).
pub fn nameservers(m: &Mode) -> Vec<IpAddr> {
    match m {
        Mode::Quad9 => vec![
            IpAddr::from([9, 9, 9, 9]),
            IpAddr::from([149, 112, 112, 112]),
        ],
        Mode::Cloudflare => vec![IpAddr::from([1, 1, 1, 1]), IpAddr::from([1, 0, 0, 1])],
        Mode::System => Vec::new(),
    }
}

/// The TLS server name the resolver's certificate must be valid for
/// (empty for System). Pinning the name, not the IP SAN, is what makes
/// DoH to a bare anycast IP verifiable.
fn tls_dns_name(m: &Mode) -> &'static str {
    match m {
        Mode::Quad9 => "dns.quad9.net",
        Mode::Cloudflare => "cloudflare-dns.com",
        Mode::System => "",
    }
}

/// Human-readable description for the startup log.
pub fn mode_description() -> String {
    match mode() {
        Mode::Quad9 => {
            "quad9 DoH (https://dns.quad9.net/dns-query via 9.9.9.9, 149.112.112.112:443) pinned; NXDOMAIN/SERVFAIL retried once through cloudflare; plaintext DNS and the system resolver unused".into()
        }
        Mode::Cloudflare => {
            "cloudflare DoH (https://cloudflare-dns.com/dns-query via 1.1.1.1, 1.0.0.1:443) pinned; NXDOMAIN/SERVFAIL retried once through quad9; plaintext DNS and the system resolver unused".into()
        }
        Mode::System => "system resolver (ZL_DNS=system; not pinned, not encrypted)".into(),
    }
}

/* The hickory default cache is 32 entries, so a busy session pays a
DoH round trip often. One shared 1024-entry LRU serves every wisp
session from this process. */
const RESOLVER_CACHE_SIZE: usize = 1024;

static PINNED: OnceLock<hickory_resolver::TokioResolver> = OnceLock::new();
static PINNED_FALLBACK: OnceLock<hickory_resolver::TokioResolver> = OnceLock::new();

/// The DoH resolver config for a mode: one HTTPS nameserver per
/// pinned IP, TLS name set, default /dns-query endpoint. Extracted so
/// the config itself is unit-testable without the process-wide
/// OnceLock.
fn pinned_config(m: &Mode) -> hickory_resolver::config::ResolverConfig {
    use hickory_resolver::config::{NameServerConfigGroup, ResolverConfig};
    let group = NameServerConfigGroup::from_ips_https(
        &nameservers(m),
        443,
        tls_dns_name(m).to_string(),
        true,
    );
    ResolverConfig::from_parts(None, vec![], group)
}

fn build_resolver(m: &Mode) -> hickory_resolver::TokioResolver {
    let mut builder = hickory_resolver::TokioResolver::builder_with_config(
        pinned_config(m),
        hickory_resolver::name_server::TokioConnectionProvider::default(),
    );
    builder.options_mut().cache_size = RESOLVER_CACHE_SIZE;
    builder.build()
}

/// Why a pinned lookup failed. Implements [std::error::Error]: this
/// type is the crate's public lookup API and downstream servers box
/// it into generic error handling (LobsterBrowse's reqwest DNS
/// resolver broke its build when the impl was missing).
#[derive(Debug, thiserror::Error)]
pub enum LookupError {
    /// NXDOMAIN/SERVFAIL from the active provider AND the fallback:
    /// the name is filtered out or does not exist. Its own diagnostic,
    /// not a generic unreachable.
    #[error(
        "dns filtered or not found: NXDOMAIN/SERVFAIL from the active provider and the fallback"
    )]
    NotFound,
    /// The resolver could not be reached or answered garbage; the
    /// string names the last error for the log.
    #[error("pinned resolver lookup failed: {0}")]
    Pinned(String),
}

/* Test-only resolution override: the connect race tests need a
hostname that "resolves" to a chosen address list (a dead first
hop and a good second hop) without real DNS. */
#[cfg(test)]
static TEST_LOOKUP: std::sync::Mutex<Option<std::collections::HashMap<String, Vec<SocketAddr>>>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_test_lookup(entries: Option<Vec<(&str, Vec<SocketAddr>)>>) {
    let mut g = TEST_LOOKUP.lock().expect("test lookup lock");
    /* Merge per hostname, never wipe sibling entries: cargo test runs
    the connect-race tests on parallel threads and a replace-then-
    clear pair in one test used to delete the other's host mid-race,
    dropping it onto the real pinned DoH (the CI flake where
    connect_races_past_a_dead_first_address died as DnsNotFound in
    ~106ms). */
    let map = g.get_or_insert_with(std::collections::HashMap::new);
    match entries {
        Some(v) => {
            for (k, addrs) in v {
                map.insert(k.to_string(), addrs);
            }
        }
        None => map.clear(),
    }
}

/* Remove exactly one hostname's override; test cleanup must not
clear entries another parallel test still depends on. */
#[cfg(test)]
pub(crate) fn remove_test_lookup(hostname: &str) {
    let mut g = TEST_LOOKUP.lock().expect("test lookup lock");
    if let Some(map) = g.as_mut() {
        map.remove(hostname);
    }
}

#[cfg(test)]
fn test_lookup(hostname: &str) -> Option<Vec<SocketAddr>> {
    TEST_LOOKUP
        .lock()
        .expect("test lookup lock")
        .as_ref()
        .and_then(|m| m.get(hostname).cloned())
}

/// Resolve a hostname to candidate SocketAddrs through the pinned
/// DoH resolver. The port is attached locally; the resolver is only
/// asked for the name. System mode delegates to tokio::net::lookup_host.
pub async fn lookup(hostname: &str, port: u16) -> Result<Vec<SocketAddr>, LookupError> {
    #[cfg(test)]
    if let Some(addrs) = test_lookup(hostname) {
        return Ok(addrs);
    }
    let active = mode();
    if matches!(active, Mode::System) {
        return tokio::net::lookup_host((hostname, port))
            .await
            .map(Iterator::collect)
            .map_err(|e| LookupError::Pinned(e.to_string()));
    }
    let answer = PINNED
        .get_or_init(|| build_resolver(active))
        .lookup_ip(hostname)
        .await;
    match answer {
        Ok(a) => {
            debug!(?active, hostname, "pinned resolver answered");
            Ok(a.iter().map(|ip| SocketAddr::new(ip, port)).collect())
        }
        Err(e) => {
            if !e.is_no_records_found() {
                return Err(LookupError::Pinned(e.to_string()));
            }
            /* NXDOMAIN/SERVFAIL: the active provider refuses the name
            (the default quad9 endpoint runs malware blocking). One
            retry through the other pinned provider keeps a flagged
            domain from reading as dead; both refusing is
            NotFound. */
            let Some(fb) = fallback_mode(active) else {
                return Err(LookupError::NotFound);
            };
            info!(
                ?active,
                hostname,
                "pinned resolver answered NXDOMAIN/SERVFAIL; retrying once through the fallback provider"
            );
            match PINNED_FALLBACK
                .get_or_init(|| build_resolver(&fb))
                .lookup_ip(hostname)
                .await
            {
                Ok(a) => {
                    info!(fallback = ?fb, hostname, "fallback pinned resolver answered");
                    Ok(a.iter().map(|ip| SocketAddr::new(ip, port)).collect())
                }
                Err(e2) if e2.is_no_records_found() => Err(LookupError::NotFound),
                Err(e2) => Err(LookupError::Pinned(e2.to_string())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    fn assert_std_error<E: std::error::Error>() {}

    #[test]
    fn lookup_error_implements_std_error() {
        assert_std_error::<LookupError>();
    }

    use super::*;
    use hickory_resolver::proto::xfer::Protocol;

    #[test]
    fn parses_known_modes_and_rejects_everything_else() {
        assert!(matches!(parse_mode("quad9"), Some(Mode::Quad9)));
        assert!(matches!(parse_mode(" Quad9 "), Some(Mode::Quad9)));
        assert!(matches!(parse_mode("cloudflare"), Some(Mode::Cloudflare)));
        assert!(matches!(parse_mode("system"), Some(Mode::System)));
        assert!(parse_mode("8.8.8.8").is_none());
        assert!(parse_mode("").is_none());
    }

    #[test]
    fn nameservers_are_quad9_or_cloudflare_never_google() {
        assert_eq!(
            nameservers(&Mode::Quad9),
            vec![
                IpAddr::from([9, 9, 9, 9]),
                IpAddr::from([149, 112, 112, 112])
            ]
        );
        assert_eq!(
            nameservers(&Mode::Cloudflare),
            vec![IpAddr::from([1, 1, 1, 1]), IpAddr::from([1, 0, 0, 1])]
        );
        assert!(nameservers(&Mode::System).is_empty());
    }

    #[test]
    fn tls_names_pin_the_resolver_not_the_ip() {
        assert_eq!(tls_dns_name(&Mode::Quad9), "dns.quad9.net");
        assert_eq!(tls_dns_name(&Mode::Cloudflare), "cloudflare-dns.com");
        assert_eq!(tls_dns_name(&Mode::System), "");
    }

    #[test]
    fn fallback_swaps_the_pinned_providers_only() {
        assert!(matches!(
            fallback_mode(&Mode::Quad9),
            Some(Mode::Cloudflare)
        ));
        assert!(matches!(
            fallback_mode(&Mode::Cloudflare),
            Some(Mode::Quad9)
        ));
        assert!(fallback_mode(&Mode::System).is_none());
    }

    #[test]
    fn doh_config_is_https_443_with_pinned_tls_names_no_port53() {
        for m in [Mode::Quad9, Mode::Cloudflare] {
            let cfg = pinned_config(&m);
            let servers = cfg.name_servers();
            assert_eq!(servers.len(), 2);
            for ns in servers {
                assert_eq!(ns.protocol, Protocol::Https);
                assert_eq!(ns.socket_addr.port(), 443);
                assert_eq!(
                    ns.tls_dns_name.as_deref(),
                    Some(tls_dns_name(&m)),
                    "every pinned nameserver must carry the TLS name"
                );
            }
        }
    }

    #[test]
    fn description_names_the_active_mode() {
        let d = mode_description();
        assert!(!d.is_empty());
        if matches!(mode(), Mode::Quad9) {
            assert!(d.contains("quad9") && d.contains("DoH"));
            assert!(d.contains("system resolver unused"));
        }
    }

    #[test]
    fn test_lookup_override_answers_without_network() {
        set_test_lookup(Some(vec![(
            "multi.example.org",
            vec!["127.0.0.1:1".parse().unwrap()],
        )]));
        assert_eq!(
            test_lookup("multi.example.org"),
            Some(vec!["127.0.0.1:1".parse().unwrap()])
        );
        assert_eq!(test_lookup("other.example.org"), None);
        set_test_lookup(None);
        assert_eq!(test_lookup("multi.example.org"), None);
    }

    // Real-network check: run manually with
    // `cargo test -p zeolite-server dns -- --ignored`. Not in CI: it
    // needs egress HTTPS/443 to the pinned resolver and would be flaky.
    #[tokio::test]
    #[ignore]
    async fn resolves_real_names_through_the_pinned_doh_resolver() {
        let addrs = lookup("example.com", 443).await.expect("pinned doh lookup");
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|a| a.port() == 443));
    }
}
