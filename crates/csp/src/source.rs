/* #615: CSP source-expression tokenizing and CSP3 host-source
semantics, ported from csp-enforce.ts (#527). Every degrade is a
false allow, never a false block: a token the parser does not
fully understand marks the whole directive unverifiable, and the
plan then leaves that directive unenforced. */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceExpression {
    /* 'self': resolves ONLY against the plan's self_origin, which
    plan_engine derives from the document URL alone (#615
    widening gate). The engine origin is never a representable
    self. */
    SelfKeyword,
    Any,
    Scheme {
        scheme: String,
    },
    Host {
        scheme: Option<String>,
        host: String,
        wildcard: bool,
        port: Option<String>,
        path: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenVerdict {
    Parsed(SourceExpression),
    /* Behavioral keywords and non-network schemes cannot cause a
    false block: skip the token. */
    Ignore,
    /* Nonce/hash/strict-dynamic/odd tokens cannot be verified at
    the fetch seam: the whole directive stays unenforced. */
    Unverifiable,
}

struct HostSourceParts<'a> {
    scheme: Option<&'a str>,
    host: &'a str,
    port: Option<&'a str>,
    path: Option<&'a str>,
}

pub fn parse_token(tok: &str) -> TokenVerdict {
    if matches!(
        tok,
        "'none'"
            | "'unsafe-inline'"
            | "'unsafe-eval'"
            | "'wasm-unsafe-eval'"
            | "'unsafe-hashes'"
            | "'report-sample'"
    ) {
        return TokenVerdict::Ignore;
    }
    if tok == "'self'" {
        return TokenVerdict::Parsed(SourceExpression::SelfKeyword);
    }
    if tok == "'strict-dynamic'" || tok == "'allow'" || tok.starts_with("'nonce-") {
        return TokenVerdict::Unverifiable;
    }
    if tok == "*" {
        return TokenVerdict::Parsed(SourceExpression::Any);
    }
    /* Hash sources are bare sha256/384/512 digests; anything else in
    that shape is more likely a single-label host, so only these
    gate. */
    if !tok.starts_with('\'') && is_hash_source(tok) {
        return TokenVerdict::Unverifiable;
    }
    /* Scheme-only source. */
    if is_scheme_source(tok) {
        let scheme = tok[..tok.len() - 1].to_ascii_lowercase();
        return if scheme == "http" || scheme == "https" {
            TokenVerdict::Parsed(SourceExpression::Scheme { scheme })
        } else {
            TokenVerdict::Ignore
        };
    }
    /* Host source: [scheme://]host[:port][/path]. */
    match split_host_source(tok) {
        None => TokenVerdict::Unverifiable,
        Some(p) => {
            if let Some(s) = p.scheme {
                if s != "http" && s != "https" {
                    return TokenVerdict::Ignore;
                }
            }
            if p.host == "*" {
                return TokenVerdict::Parsed(SourceExpression::Any);
            }
            let mut wildcard = false;
            let mut host = p.host.to_ascii_lowercase();
            if let Some(stripped) = host.strip_prefix("*.") {
                wildcard = true;
                host = stripped.to_string();
            }
            /* IPv6 literals and anything unusual stay unverifiable. */
            if host.is_empty()
                || !host
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
            {
                return TokenVerdict::Unverifiable;
            }
            if host.contains('*') {
                return TokenVerdict::Unverifiable;
            }
            TokenVerdict::Parsed(SourceExpression::Host {
                scheme: p.scheme.map(|s| s.to_ascii_lowercase()),
                host,
                wildcard,
                port: p.port.map(str::to_string),
                path: p.path.map(str::to_string),
            })
        }
    }
}

pub fn parse_source_list(tokens: &[&str]) -> Option<Vec<SourceExpression>> {
    let mut out = Vec::new();
    for tok in tokens {
        match parse_token(tok) {
            TokenVerdict::Parsed(src) => out.push(src),
            TokenVerdict::Ignore => {}
            TokenVerdict::Unverifiable => return None,
        }
    }
    Some(out)
}

fn is_hash_source(tok: &str) -> bool {
    let digest = match tok
        .strip_prefix("sha256-")
        .or_else(|| tok.strip_prefix("sha384-"))
        .or_else(|| tok.strip_prefix("sha512-"))
    {
        Some(d) => d,
        None => return false,
    };
    !digest.is_empty()
        && digest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

fn is_scheme_source(tok: &str) -> bool {
    match tok.strip_suffix(':') {
        Some(body) => valid_scheme_body(body),
        None => false,
    }
}

fn valid_scheme_body(body: &str) -> bool {
    let mut chars = body.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')
}

/* The shape the CSP3 host-source regex accepts: an optional
[scheme]:// (an empty scheme still delimits, like the optional
capture group), then host[:port][/path] with host [^/:]+ and
port (\*|\d+). A tail outside that shape has no regex match,
which the caller treats as unverifiable. */
fn split_host_source(tok: &str) -> Option<HostSourceParts<'_>> {
    match tok.find("://") {
        Some(at) => {
            let head = &tok[..at];
            if !head.is_empty() && !valid_scheme_body(head) {
                return None;
            }
            let tail = &tok[at + 3..];
            parse_host_tail(tail).map(|(host, port, path)| HostSourceParts {
                scheme: if head.is_empty() { None } else { Some(head) },
                host,
                port,
                path,
            })
        }
        None => parse_host_tail(tok).map(|(host, port, path)| HostSourceParts {
            scheme: None,
            host,
            port,
            path,
        }),
    }
}

fn parse_host_tail(tail: &str) -> Option<(&str, Option<&str>, Option<&str>)> {
    let bytes = tail.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] != b':' && bytes[i] != b'/' {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let host = &tail[..i];
    let mut port = None;
    if i < bytes.len() && bytes[i] == b':' {
        i += 1;
        if i < bytes.len() && bytes[i] == b'*' {
            port = Some("*");
            i += 1;
        } else {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                return None;
            }
            port = Some(&tail[start..i]);
        }
    }
    let path = if i < bytes.len() {
        if bytes[i] != b'/' {
            return None;
        }
        Some(&tail[i..])
    } else {
        None
    };
    Some((host, port, path))
}
