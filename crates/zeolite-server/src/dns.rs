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

use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;
use tracing::warn;

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
            "quad9 DoH (https://dns.quad9.net/dns-query via 9.9.9.9, 149.112.112.112:443) pinned; plaintext DNS and the system resolver unused".into()
        }
        Mode::Cloudflare => {
            "cloudflare DoH (https://cloudflare-dns.com/dns-query via 1.1.1.1, 1.0.0.1:443) pinned; plaintext DNS and the system resolver unused".into()
        }
        Mode::System => "system resolver (ZL_DNS=system; not pinned, not encrypted)".into(),
    }
}

static PINNED: OnceLock<hickory_resolver::TokioResolver> = OnceLock::new();

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

fn pinned() -> &'static hickory_resolver::TokioResolver {
    PINNED.get_or_init(|| {
        let config = pinned_config(mode());
        let builder = hickory_resolver::TokioResolver::builder_with_config(
            config,
            hickory_resolver::name_server::TokioConnectionProvider::default(),
        );
        builder.build()
    })
}

/// Resolve a hostname to candidate SocketAddrs through the pinned
/// DoH resolver. The port is attached locally; the resolver is only
/// asked for the name. System mode delegates to tokio::net::lookup_host.
pub async fn lookup(hostname: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    if matches!(mode(), Mode::System) {
        return tokio::net::lookup_host((hostname, port))
            .await
            .map(Iterator::collect);
    }
    let answer = pinned()
        .lookup_ip(hostname)
        .await
        .map_err(|e| std::io::Error::other(format!("pinned doh: {e}")))?;
    Ok(answer.iter().map(|ip| SocketAddr::new(ip, port)).collect())
}

#[cfg(test)]
mod tests {
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
