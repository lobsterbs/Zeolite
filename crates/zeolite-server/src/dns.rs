//! Pinned upstream DNS for wisp destinations.
//!
//! Privacy pin: every hostname a proxied request targets is resolved
//! through the pinned public resolver, not the deployment host's
//! system resolver and never Google DNS. ZL_DNS selects the mode:
//!
//! - "quad9" (default): Quad9 anycast 9.9.9.9 + 149.112.112.112
//! - "cloudflare":      Cloudflare 1.1.1.1 + 1.0.0.1
//! - "system":         the host resolver via tokio::net::lookup_host
//!   (explicit operator opt-out for restricted-egress hosts; the
//!   startup log names whatever is active)
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

/// Human-readable description for the startup log.
pub fn mode_description() -> String {
    match mode() {
        Mode::Quad9 => "quad9 (9.9.9.9, 149.112.112.112) pinned; system resolver unused".into(),
        Mode::Cloudflare => "cloudflare (1.1.1.1, 1.0.0.1) pinned; system resolver unused".into(),
        Mode::System => "system resolver (ZL_DNS=system; not pinned)".into(),
    }
}

static PINNED: OnceLock<hickory_resolver::TokioResolver> = OnceLock::new();

fn pinned() -> &'static hickory_resolver::TokioResolver {
    PINNED.get_or_init(|| {
        use hickory_resolver::config::{NameServerConfigGroup, ResolverConfig};
        let ips = nameservers(mode());
        // from_ips_clear registers each IP over UDP and TCP (53), and
        // try_tcp_on_error retries over TCP when UDP fails, so a
        // truncated or blocked UDP answer does not end the lookup.
        let group = NameServerConfigGroup::from_ips_clear(&ips, 53, true);
        let config = ResolverConfig::from_parts(None, vec![], group);
        let mut builder = hickory_resolver::TokioResolver::builder_with_config(
            config,
            hickory_resolver::name_server::TokioConnectionProvider::default(),
        );
        builder.options_mut().try_tcp_on_error = true;
        builder.build()
    })
}

/// Resolve a hostname to candidate SocketAddrs through the pinned
/// resolver. The port is attached locally; the resolver is only asked
/// for the name. System mode delegates to tokio::net::lookup_host.
pub async fn lookup(hostname: &str, port: u16) -> std::io::Result<Vec<SocketAddr>> {
    if matches!(mode(), Mode::System) {
        return tokio::net::lookup_host((hostname, port))
            .await
            .map(Iterator::collect);
    }
    let answer = pinned()
        .lookup_ip(hostname)
        .await
        .map_err(|e| std::io::Error::other(format!("pinned dns: {e}")))?;
    Ok(answer.iter().map(|ip| SocketAddr::new(ip, port)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn description_names_the_active_mode() {
        let d = mode_description();
        assert!(!d.is_empty());
        if matches!(mode(), Mode::Quad9) {
            assert!(d.contains("quad9") && d.contains("system resolver unused"));
        }
    }

    // Real-network check: run manually with
    // `cargo test -p zeolite-server dns -- --ignored`. Not in CI: it
    // needs egress UDP/53 to the pinned resolver and would be flaky.
    #[tokio::test]
    #[ignore]
    async fn resolves_real_names_through_the_pinned_resolver() {
        let addrs = lookup("example.com", 443).await.expect("pinned lookup");
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|a| a.port() == 443));
    }
}
