//! URL codec: destination URLs encoded into engine-local paths.
//!
//! The codec is swappable so the URL shape can rotate (Phase 2 makes the
//! scheme configurable per deployment). Phase 1 ships Base64Url under
//! `/j/` and a path-mirror stub for future schemes.

/// Installed codec scheme.
#[derive(Debug, Clone)]
pub enum Codec {
    /// `/j/<base64url of absolute destination URL>` (default).
    Base64Url { prefix: String },
    /// Path mirroring (site visible in the path). Stub, Phase 2.
    PathMirror,
}

/// Decode a path into the destination URL. Returns None if the path does
/// not belong to the engine's path scheme.
pub fn decode_path(codec: &Codec, origin: &str, path: &str) -> Option<String> {
    let local = path.strip_prefix(origin).unwrap_or(path);
    match codec {
        Codec::Base64Url { prefix } => {
            let rest = local.strip_prefix(prefix.as_str())?;
            let bytes = b64u_decode(rest)?;
            String::from_utf8(bytes).ok()
        }
        Codec::PathMirror => {
            let rest = local.strip_prefix("/m/")?;
            Some(rest.to_string())
        }
    }
}

/* ---- tiny base64url, no external deps (keeps the wasm bundle small) ---- */

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64u_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).map_or(0, |b| *b as u32);
        let b2 = chunk.get(2).map_or(0, |b| *b as u32);
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[n as usize & 63] as char);
        }
    }
    out
}

pub fn b64u_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// RFC 3986 scheme: ALPHA followed by ALPHA / DIGIT / "+" / "-" / ".".
fn is_scheme(s: &str) -> bool {
    let mut b = s.bytes();
    match b.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    b.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.'))
}

/// Split `s` (an authority followed by its path/query/fragment tail)
/// into userinfo, lowercased host:port and tail. WHATWG special schemes
/// normalize the host to lowercase; userinfo and path keep their case
/// (issue #19).
fn split_authority(s: &str) -> (String, String, &str) {
    let auth_end = s.find(['/', '?', '#']).unwrap_or(s.len());
    let (auth, tail) = s.split_at(auth_end);
    let (userinfo, hostport) = match auth.rfind('@') {
        Some(i) => (&auth[..i + 1], &auth[i + 1..]),
        None => ("", auth),
    };
    (userinfo.to_string(), hostport.to_ascii_lowercase(), tail)
}

/// Resolve `url` against `base` (the current page's real destination URL).
/// Hand-rolled to keep the wasm bundle free of a URL crate; follows the
/// WHATWG URL algorithm for the forms that occur in real markup
/// (absolute, protocol-relative, root-relative, path-relative,
/// query-only): dot segments with trailing-segment semantics, preserved
/// empty path segments, backslash-as-slash for special-scheme bases and
/// scheme/host lowercasing all match `new URL(url, base)` (issue #19).
///
/// Two deliberate deviations, both intentional for a rewriter: the empty
/// string and fragment-only references resolve to themselves so the
/// caller keeps them client-side (issue #12) instead of encoding a
/// route for the base document.
pub fn resolve(url: &str, base: &str) -> String {
    let url = url.trim();
    if url.is_empty() || url.starts_with('#') {
        return url.to_string();
    }
    // Engine-local paths and other non-URLs pass through untouched.
    // A scheme is ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":" per RFC
    // 3986; anything else falls through to relative resolution.
    if let Some(ci) = url.find(':') {
        if is_scheme(&url[..ci]) {
            let sch = &url[..ci];
            // WHATWG parity (issue #19): for special schemes the
            // browser lowercases scheme and host (never userinfo or
            // path) before navigating; the encoded destination must
            // match what the page actually loads or cache keys and
            // host matching drift.
            if (sch.eq_ignore_ascii_case("http") || sch.eq_ignore_ascii_case("https"))
                && url[ci..].starts_with("://")
            {
                let (userinfo, hostport, tail) = split_authority(&url[ci + 3..]);
                return format!(
                    "{}://{}{}{}",
                    sch.to_ascii_lowercase(),
                    userinfo,
                    hostport,
                    tail
                );
            }
            return url.to_string();
        }
    }
    if url.starts_with("data:")
        || url.starts_with("blob:")
        || url.starts_with("javascript:")
        || url.starts_with("mailto:")
        || url.starts_with("tel:")
    {
        return url.to_string();
    }
    // Split base into scheme://host and path.
    let (scheme, rest) = match base.find("://") {
        Some(i) => (&base[..i + 3], &base[i + 3..]),
        None => return url.to_string(),
    };
    let (host, base_path) = match rest.find(['/', '?', '#']) {
        Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], &rest[i..]),
        // No path before the query/fragment: the base path is "/".
        Some(i) => (&rest[..i], "/"),
        None => (rest, "/"),
    };
    let root = format!("{}{}", scheme, host);
    // WHATWG parity (issue #19): a special-scheme base treats "\"
    // exactly like "/" everywhere a browser would.
    let special = scheme.eq_ignore_ascii_case("https://") || scheme.eq_ignore_ascii_case("http://");
    let rel = if special {
        url.replace('\\', "/")
    } else {
        url.to_string()
    };
    if let Some(p) = rel.strip_prefix("//") {
        // Protocol-relative, with the same host normalization.
        let (userinfo, hostport, tail) = split_authority(p);
        return format!("{}{}{}{}", scheme, userinfo, hostport, tail);
    }
    if rel.starts_with('/') {
        return format!("{}{}", root, rel);
    }
    if rel.starts_with('?') {
        let p = base_path.split(['?', '#']).next().unwrap_or("/");
        return format!("{}{}{}", root, p, rel);
    }
    // Path-relative: WHATWG dot-segment elimination against the base's
    // directory. "." and ".." as the final segment resolve to an empty
    // final segment (a trailing slash); empty segments from "//" are
    // preserved (issue #19).
    let (path_part, suffix) = match rel.find(['?', '#']) {
        Some(i) => (&rel[..i], &rel[i..]),
        None => (rel.as_str(), ""),
    };
    let base_dir = base_path.split(['?', '#']).next().unwrap_or("/");
    let dir = match base_dir.rfind('/') {
        Some(i) => &base_dir[..i + 1],
        None => "/",
    };
    let mut segs: Vec<&str> = if dir == "/" {
        Vec::new()
    } else {
        dir[1..dir.len() - 1].split('/').collect()
    };
    let parts: Vec<&str> = path_part.split('/').collect();
    for (i, seg) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        match *seg {
            "." if last => segs.push(""),
            "." => {}
            ".." => {
                segs.pop();
                if last {
                    segs.push("");
                }
            }
            s => segs.push(s),
        }
    }
    let path = if segs.is_empty() {
        String::new()
    } else {
        format!("/{}", segs.join("/"))
    };
    format!("{}{}{}", root, path, suffix)
}

/// Extract the host from an absolute URL (scheme://[user@]host[:port]/...).
/// Naive but sufficient for block matching; returns None for relative
/// or non-HTTP URLs. IPv6 bracket form supported.
pub fn url_host(url: &str) -> Option<&str> {
    let idx = url.find("://")?;
    let rest = &url[idx + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let hostport = match authority.rfind('@') {
        Some(i) => &authority[i + 1..], // strip userinfo
        None => authority,
    };
    if let Some(start) = hostport.strip_prefix('[') {
        let close = start.find(']')?;
        return Some(&hostport[..close + 2]);
    }
    match hostport.rfind(':') {
        Some(i)
            if !hostport[i + 1..].is_empty()
                && hostport[i + 1..].chars().all(|c| c.is_ascii_digit()) =>
        {
            Some(&hostport[..i])
        }
        _ => Some(hostport),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert_eq!(url_host("https://example.com/x"), Some("example.com"));
        assert_eq!(url_host("https://EXAMPLE.com:8443/x"), Some("EXAMPLE.com"));
        assert_eq!(
            url_host("http://u:p@cdn.example.net/x"),
            Some("cdn.example.net")
        );
        assert_eq!(url_host("https://[::1]:8443/x"), Some("[::1]"));
        assert_eq!(url_host("/relative"), None);
    }

    #[test]
    fn b64_roundtrip() {
        for s in [
            "",
            "a",
            "ab",
            "abc",
            "https://example.com/x?y=1",
            "Ã¼nÃ¯code",
        ] {
            assert_eq!(
                b64u_decode(&b64u_encode(s.as_bytes())).unwrap(),
                s.as_bytes()
            );
        }
    }

    #[test]
    fn resolve_forms() {
        let b = "https://example.com/a/b/c.html";
        assert_eq!(resolve("d.png", b), "https://example.com/a/b/d.png");
        assert_eq!(resolve("/x", b), "https://example.com/x");
        assert_eq!(
            resolve("//cdn.example.net/x", b),
            "https://cdn.example.net/x"
        );
        assert_eq!(resolve("?q=1", b), "https://example.com/a/b/c.html?q=1");
        assert_eq!(resolve("../up", b), "https://example.com/a/up");
        assert_eq!(
            resolve("https://other.example/", b),
            "https://other.example/"
        );
        assert_eq!(resolve("#frag", b), "#frag");
        assert_eq!(
            resolve("data:image/png;base64,AAA", b),
            "data:image/png;base64,AAA"
        );
    }

    /// Issue #19: WHATWG conformance table. Every expected value is
    /// `new URL(input, base).href` from a real browser, except the two
    /// documented deviations (empty and fragment-only references return
    /// themselves so the rewriter keeps them client-side, see #12).
    #[test]
    fn resolve_whatwg_table() {
        let b = "https://example.com/a/b/c.html";
        let table: &[(&str, &str, &str)] = &[
            // (input, base, expected)
            ("d.png", b, "https://example.com/a/b/d.png"),
            ("../up", b, "https://example.com/a/up"),
            (".", b, "https://example.com/a/b/"),
            ("..", b, "https://example.com/a/"),
            ("./", b, "https://example.com/a/b/"),
            ("../../x", b, "https://example.com/x"),
            ("../../../../x", b, "https://example.com/x"),
            // Empty segments from "//" are preserved.
            ("a//b", b, "https://example.com/a/b/a//b"),
            (
                "..",
                "https://example.com/a//b/c.html",
                "https://example.com/a//",
            ),
            (
                "../up",
                "https://example.com/a//b/c.html",
                "https://example.com/a//up",
            ),
            ("y", "https://example.com//x", "https://example.com//y"),
            ("y", "https://example.com//x/", "https://example.com//x/y"),
            (
                "g",
                "https://example.com:8443/a/b/c.html",
                "https://example.com:8443/a/b/g",
            ),
            ("g", "https://example.com", "https://example.com/g"),
            ("/x", b, "https://example.com/x"),
            ("//cdn.example.net/x", b, "https://cdn.example.net/x"),
            // Backslash is slash for special-scheme bases.
            ("\\x", b, "https://example.com/x"),
            ("a\\b.html", b, "https://example.com/a/b/a/b.html"),
            ("\\\\cdn.example.net\\x", b, "https://cdn.example.net/x"),
            // Query-only replaces the query and drops the fragment.
            ("?q=1", b, "https://example.com/a/b/c.html?q=1"),
            ("?", b, "https://example.com/a/b/c.html?"),
            (
                "?z=2",
                "https://example.com/a/b/c.html#top",
                "https://example.com/a/b/c.html?z=2",
            ),
            // Scheme and host lowercase; userinfo and path do not.
            ("HTTPS://EXAMPLE.COM/x", b, "https://example.com/x"),
            (
                "HtTp://User:Pw@EXAMPLE.com:8080/PaTh",
                b,
                "http://User:Pw@example.com:8080/PaTh",
            ),
            // Percent-sequences pass through untouched.
            ("a%20b.png", b, "https://example.com/a/b/a%20b.png"),
            ("/%7Euser", b, "https://example.com/%7Euser"),
            ("%41", b, "https://example.com/a/b/%41"),
            // Opaque schemes stay untouched.
            ("data:image/png;base64,AAA", b, "data:image/png;base64,AAA"),
            (
                "blob:https://example.com/x",
                b,
                "blob:https://example.com/x",
            ),
            ("javascript:void(0)", b, "javascript:void(0)"),
            ("mailto:a@b.c", b, "mailto:a@b.c"),
            ("tel:+15551234", b, "tel:+15551234"),
            ("about:blank", b, "about:blank"),
            // Documented deviations: kept client-side by the caller.
            ("#frag", b, "#frag"),
            ("#frag", "https://example.com/a/b/c.html?q=1", "#frag"),
            ("", b, ""),
            ("#", b, "#"),
        ];
        for (input, base, expected) in table {
            assert_eq!(
                resolve(input, base),
                *expected,
                "resolve({input:?}, {base:?})"
            );
        }
    }

    #[test]
    fn codec_roundtrip() {
        let c = Codec::Base64Url {
            prefix: "/j/".into(),
        };
        let dest = "https://example.com/page";
        let path = format!("/j/{}", b64u_encode(dest.as_bytes()));
        assert_eq!(decode_path(&c, "", &path).unwrap(), dest);
        assert!(decode_path(&c, "", "/other").is_none());
    }
}
