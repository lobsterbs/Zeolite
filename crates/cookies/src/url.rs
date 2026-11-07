//! Minimal http(s) origin parse for the pure jar.
//!
//! The wasm boundary passes already-parsed pieces; this helper
//! covers the crate's own tests and callers holding a bare URL
//! string. Host is lowercased without the port (an IPv6 literal
//! keeps its brackets, the JS URL().hostname shape the loopback
//! checks match), path defaults to "/".

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub host: String,
    pub path: String,
    pub secure: bool,
}

pub fn parse_http_url(u: &str) -> Option<Origin> {
    let (secure, rest) = if let Some(r) = u.strip_prefix("https://") {
        (true, r)
    } else {
        (false, u.strip_prefix("http://")?)
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority_host(authority)?;
    let raw_path = &rest[end..];
    let path = match raw_path.find(['?', '#']) {
        Some(i) => &raw_path[..i],
        None => raw_path,
    };
    let path = if path.is_empty() { "/" } else { path };
    Some(Origin {
        host,
        path: path.to_string(),
        secure,
    })
}

fn authority_host(authority: &str) -> Option<String> {
    let host_port = match authority.rfind('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    };
    if let Some(open) = host_port.find('[') {
        let close = host_port.find(']')?;
        return Some(host_port[open..=close].to_lowercase());
    }
    let host = match host_port.find(':') {
        Some(i) => &host_port[..i],
        None => host_port,
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_path_and_scheme() {
        let o = parse_http_url("https://a.example/x/y").unwrap();
        assert_eq!(o.host, "a.example");
        assert_eq!(o.path, "/x/y");
        assert!(o.secure);
        let p = parse_http_url("http://a.example:8443").unwrap();
        assert_eq!(p.host, "a.example");
        assert_eq!(p.path, "/");
        assert!(!p.secure);
    }

    #[test]
    fn refuses_non_http_schemes_and_empty_hosts() {
        assert!(parse_http_url("ftp://a.example/").is_none());
        assert!(parse_http_url("https:///x").is_none());
    }

    #[test]
    fn ipv6_literal_keeps_brackets() {
        let o = parse_http_url("http://[::1]:6002/").unwrap();
        assert_eq!(o.host, "[::1]");
    }
}
