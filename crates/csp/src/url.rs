/* #615: minimal WHATWG-subset URL parse for the CSP layer, the
surface the engine-side matcher consults: scheme, host, port
(scheme default ports dropped like the WHATWG parser, #629) and
the raw pathname. Non-http(s) schemes parse opaquely (only the
scheme is consulted by the callers); malformed input is an error
instead of a panic. ponytail: ASCII host lowercasing, no IDNA and
no percent normalization; the path compare is raw and the corpus
is ASCII, upgrade if a live policy needs it. */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub scheme: String,
    pub host: String,
    pub port: String,
    pub pathname: String,
}

impl Url {
    pub fn parse(raw: &str) -> Option<Url> {
        let colon = raw.find(':')?;
        let scheme_raw = &raw[..colon];
        if !valid_scheme(scheme_raw) {
            return None;
        }
        let scheme = scheme_raw.to_ascii_lowercase();
        let rest = &raw[colon + 1..];
        if scheme != "http" && scheme != "https" {
            /* Opaque scheme: only the scheme is consulted. */
            return Some(Url {
                scheme,
                host: String::new(),
                port: String::new(),
                pathname: String::new(),
            });
        }
        let after = rest.strip_prefix("//")?;
        let auth_end = after.find(['/', '?', '#']).unwrap_or(after.len());
        let authority = &after[..auth_end];
        let tail = &after[auth_end..];
        let hostport = match authority.rfind('@') {
            Some(i) => &authority[i + 1..],
            None => authority,
        };
        let (host_raw, port_raw) = match hostport.strip_prefix('[') {
            Some(inner) => {
                let close = inner.find(']')?;
                let port = if inner.len() > close + 1 {
                    inner[close + 1..].strip_prefix(':')?
                } else {
                    ""
                };
                (&hostport[..close + 2], port)
            }
            None => match hostport.find(':') {
                Some(i) => (&hostport[..i], &hostport[i + 1..]),
                None => (hostport, ""),
            },
        };
        let host = host_raw.to_ascii_lowercase();
        if host.is_empty() {
            return None;
        }
        if !port_raw.is_empty() && !port_raw.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        /* The parser drops the scheme's default port (#629). */
        let port = match (port_raw, scheme.as_str()) {
            ("80", "http") | ("443", "https") => String::new(),
            (p, _) => p.to_string(),
        };
        let path_and_query = match tail.find('#') {
            Some(i) => &tail[..i],
            None => tail,
        };
        let path_part = match path_and_query.find('?') {
            Some(i) => &path_and_query[..i],
            None => path_and_query,
        };
        let pathname = if path_part.starts_with('/') {
            path_part.to_string()
        } else {
            "/".to_string()
        };
        Some(Url {
            scheme,
            host,
            port,
            pathname,
        })
    }

    pub fn origin(&self) -> String {
        let mut s = format!("{}://{}", self.scheme, self.host);
        if !self.port.is_empty() {
            s.push(':');
            s.push_str(&self.port);
        }
        s
    }

    pub fn is_network(&self) -> bool {
        self.scheme == "http" || self.scheme == "https"
    }
}

fn valid_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
}
