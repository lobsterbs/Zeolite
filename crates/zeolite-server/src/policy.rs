//! Destination policy for TCP, UDP and DNS destinations.
//!
//! One policy answers every "may we reach this destination?" question
//! in the server, so SSRF rules live in exactly one place:
//! - hostnames are checked before DNS resolution (local names),
//! - every RESOLVED address is checked again before connect, so a DNS
//!   rebinding answer pointing into private space is rejected.
//!
//! Blocked ranges: loopback, private (RFC1918), link-local (including
//! 169.254.169.254 cloud metadata), unspecified, broadcast, IPv6
//! unique-local fc00::/7 and link-local fe80::/10.

use std::net::IpAddr;

/// Verdict for a requested destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Block,
}

/// Address ranges that must never be reachable through the relay.
#[derive(Debug, Clone)]
pub struct DestinationPolicy {
    /// Block requests whose hostname is obviously local (before DNS).
    pub block_local_names: bool,
    /// Block destinations that resolve into private/loopback space.
    pub block_private_ips: bool,
}

impl Default for DestinationPolicy {
    fn default() -> Self {
        // Test escape hatch ONLY: the nightly compat suite runs the
        // engine against a fixture origin on 127.0.0.1. Production
        // must never set this; the default stays fully locked down.
        let test_private = std::env::var("ZL_TEST_ALLOW_PRIVATE_DESTS")
            .map(|v| v == "1")
            .unwrap_or(false);
        Self {
            block_local_names: true,
            block_private_ips: !test_private,
        }
    }
}

impl DestinationPolicy {
    /// Check a hostname before DNS resolution.
    pub fn check_hostname(&self, hostname: &str) -> Verdict {
        if !self.block_local_names {
            return Verdict::Allow;
        }
        let h = hostname.trim_end_matches('.').to_ascii_lowercase();
        let local = matches!(
            h.as_str(),
            "localhost"
                | "ip6-localhost"
                | "ip6-loopback"
                | "metadata"
                | "metadata.google.internal"
        );
        if local || h.ends_with(".local") || h.ends_with(".internal") || h.ends_with(".home.arpa") {
            return Verdict::Block;
        }
        // Literal-IP destination: apply the IP policy directly.
        if let Ok(ip) = h.parse::<IpAddr>() {
            return self.check_ip(&ip);
        }
        Verdict::Allow
    }

    /// Check a resolved IP (or a literal-IP destination).
    pub fn check_ip(&self, ip: &IpAddr) -> Verdict {
        if !self.block_private_ips {
            return Verdict::Allow;
        }
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                    || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
            }
        };
        if blocked {
            Verdict::Block
        } else {
            Verdict::Allow
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_local_hostnames() {
        let p = DestinationPolicy::default();
        assert_eq!(p.check_hostname("localhost"), Verdict::Block);
        assert_eq!(p.check_hostname("metadata.google.internal"), Verdict::Block);
        assert_eq!(p.check_hostname("printer.local"), Verdict::Block);
        assert_eq!(p.check_hostname("example.com."), Verdict::Allow);
    }

    #[test]
    fn blocks_private_ips() {
        let p = DestinationPolicy::default();
        for s in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "172.16.5.5",
            "169.254.169.254",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fc00::5",
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert_eq!(p.check_ip(&ip), Verdict::Block, "should block {s}");
        }
        assert_eq!(p.check_ip(&"1.1.1.1".parse().unwrap()), Verdict::Allow);
        assert_eq!(
            p.check_ip(&"2606:4700::1111".parse().unwrap()),
            Verdict::Allow
        );
    }

    #[test]
    fn literal_ip_hostname_checked() {
        let p = DestinationPolicy::default();
        assert_eq!(p.check_hostname("127.0.0.1"), Verdict::Block);
        assert_eq!(p.check_hostname("93.184.216.34"), Verdict::Allow);
    }

    #[test]
    fn toggles_disable_checks() {
        let p = DestinationPolicy {
            block_local_names: false,
            ..Default::default()
        };
        assert_eq!(p.check_hostname("localhost"), Verdict::Allow);
        let p = DestinationPolicy {
            block_private_ips: false,
            ..Default::default()
        };
        assert_eq!(p.check_ip(&"127.0.0.1".parse().unwrap()), Verdict::Allow);
    }
}
