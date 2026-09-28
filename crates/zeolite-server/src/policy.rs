//! Destination policy for TCP, UDP and DNS destinations.
//!
//! One policy answers every "may we reach this destination?" question
//! in the server, so SSRF rules live in exactly one place:
//! - hostnames are checked before DNS resolution (local names),
//! - every RESOLVED address is checked again before connect, so a DNS
//!   rebinding answer pointing into private space is rejected.
//!
//! Blocked ranges: loopback, private (RFC1918), link-local (including
//! 169.254.169.254 cloud metadata), unspecified, broadcast, multicast,
//! 0.0.0.0/8, CGNAT 100.64.0.0/10 (which contains the Alibaba metadata
//! address), 192.0.0.0/24 (Oracle metadata lives there), the TEST-NET
//! blocks, benchmarking 198.18.0.0/15, reserved 240.0.0.0/4, IPv6
//! unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10,
//! multicast ff00::/8, documentation 2001:db8::/32, Teredo 2001::/32
//! and, critically, every IPv4 address embedded in an IPv6 form
//! (mapped ::ffff:0:0/96, compatible ::/96, NAT64 64:ff9b::/96, 6to4
//! 2002::/16): a dual-stack socket routes those to the embedded IPv4,
//! so the v4 rules apply to them (issue #14).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

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
            IpAddr::V4(v4) => v4_blocked(v4),
            // Issue #14: canonicalize embedded IPv4 first. A dual-stack
            // Linux socket routes ::ffff:127.0.0.1 (and the NAT64/6to4
            // forms) straight to the embedded IPv4, so an AAAA record
            // hiding a loopback or metadata address must be judged by
            // the v4 rules, not the v6 ones.
            IpAddr::V6(v6) => match embedded_v4(v6) {
                Some(v4) => v4_blocked(&v4),
                None => v6_blocked(v6),
            },
        };
        if blocked {
            Verdict::Block
        } else {
            Verdict::Allow
        }
    }
}

/// Every IPv4 range the relay must never reach. std covers loopback,
/// RFC1918 private, link-local (169.254.0.0/16, which includes the
/// 169.254.169.254 cloud metadata services), broadcast, unspecified
/// and multicast; the rest are explicit (issue #14).
fn v4_blocked(v4: &Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_broadcast()
        || v4.is_unspecified()
        || v4.is_multicast() // 224.0.0.0/4
        || o[0] == 0 // 0.0.0.0/8 "this network"
        || (o[0] == 100 && (o[1] & 0xc0) == 0x40) // 100.64.0.0/10 CGNAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24 special use
        || (o[0] == 192 && o[1] == 0 && o[2] == 2) // 192.0.2.0/24 TEST-NET-1
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15 benchmarking
        || (o[0] == 198 && o[1] == 51 && o[2] == 100) // 198.51.100.0/24 TEST-NET-2
        || (o[0] == 203 && o[1] == 0 && o[2] == 113) // 203.0.113.0/24 TEST-NET-3
        || (o[0] & 0xf0) == 0xf0 // 240.0.0.0/4 reserved
}

/// IPv6 special-use ranges that carry no embedded IPv4 (issue #14).
fn v6_blocked(v6: &Ipv6Addr) -> bool {
    let s = v6.segments();
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast() // ff00::/8
        || (s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
        || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (s[0] & 0xffc0) == 0xfec0 // site-local fec0::/10
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation 2001:db8::/32
        || (s[0] == 0x2001 && s[1] == 0x0000) // Teredo 2001::/32
}

/// IPv4 addresses embedded in IPv6 forms (issue #14).
fn embedded_v4(v6: &Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4); // IPv4-mapped ::ffff:a.b.c.d
    }
    let s = v6.segments();
    if s[0] == 0x2002 {
        // 6to4 2002::/16: the first 32 payload bits are the v4 address.
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            (s[1] & 0xff) as u8,
            (s[2] >> 8) as u8,
            (s[2] & 0xff) as u8,
        ));
    }
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        // NAT64 64:ff9b::/96: the low 32 bits are the v4 address.
        return Some(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        ));
    }
    // IPv4-compatible ::a.b.c.d (deprecated, but a dual-stack socket
    // still routes it to the embedded IPv4).
    v6.to_ipv4()
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

    /// Issue #14: every row of the special-use table that used to pass.
    #[test]
    fn blocks_special_use_ranges() {
        let p = DestinationPolicy::default();
        for s in [
            "0.1.2.3",         // 0.0.0.0/8
            "100.64.0.1",      // CGNAT 100.64.0.0/10
            "100.100.100.200", // Alibaba metadata, inside CGNAT
            "192.0.0.9",       // 192.0.0.0/24 (Oracle metadata lives here)
            "192.0.2.7",       // TEST-NET-1
            "198.18.0.5",      // benchmarking 198.18.0.0/15
            "198.51.100.7",    // TEST-NET-2
            "203.0.113.9",     // TEST-NET-3
            "224.0.0.1",       // multicast
            "239.255.255.250", // SSDP multicast
            "240.1.2.3",       // reserved 240.0.0.0/4
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert_eq!(p.check_ip(&ip), Verdict::Block, "should block {s}");
        }
        for s in [
            "::ffff:127.0.0.1",       // mapped loopback
            "::ffff:169.254.169.254", // mapped cloud metadata
            "::ffff:10.0.0.1",        // mapped RFC1918
            "::127.0.0.1",            // compatible-form loopback
            "::0.0.0.2",              // compatible form, 0.0.0.0/8
            "64:ff9b::7f00:1",        // NAT64 embedding 127.0.0.1
            "64:ff9b::a00:1",         // NAT64 embedding 10.0.0.1
            "2002:7f00:1::",          // 6to4 embedding 127.0.0.1
            "2002:a00:1::",           // 6to4 embedding 10.0.0.1
            "ff02::1",                // multicast
            "fec0::1",                // site-local
            "2001:db8::1",            // documentation
            "2001::0.0.0.1",          // Teredo 2001::/32
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert_eq!(p.check_ip(&ip), Verdict::Block, "should block {s}");
        }
    }

    /// Issue #14: global addresses, including embedded globals, stay allowed.
    #[test]
    fn allows_global_and_embedded_global() {
        let p = DestinationPolicy::default();
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "::ffff:8.8.8.8",   // mapped, embedded address is global
            "64:ff9b::808:808", // NAT64 embedding 8.8.8.8
            "2002:808:808::",   // 6to4 embedding 8.8.8.8
            "2606:4700::1111",
            "2001:4860:4860::8888", // global 2001:: space, not Teredo
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert_eq!(p.check_ip(&ip), Verdict::Allow, "should allow {s}");
        }
    }

    #[test]
    fn literal_ip_hostname_checked() {
        let p = DestinationPolicy::default();
        assert_eq!(p.check_hostname("127.0.0.1"), Verdict::Block);
        assert_eq!(p.check_hostname("::ffff:127.0.0.1"), Verdict::Block);
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
