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
    /// Keyed opaque routes (#55): `/j/<base64url of 0x01 || IV(16) ||
    /// dest XOR keystream>`, minted and verified with a 16-byte
    /// SW-realm key. Legacy tails still decode under this codec
    /// (dual decode: routes minted before the key existed stay valid).
    Keyed { prefix: String, key: [u8; 16] },
}

/// Decode a path into the destination URL. Returns None if the path does
/// not belong to the engine's path scheme.
pub fn decode_path(codec: &Codec, origin: &str, path: &str) -> Option<String> {
    let local = path.strip_prefix(origin).unwrap_or(path);
    match codec {
        Codec::PathMirror => {
            let rest = local.strip_prefix("/m/")?;
            Some(rest.to_string())
        }
        Codec::Base64Url { prefix } | Codec::Keyed { prefix, .. } => {
            let rest = local.strip_prefix(prefix.as_str())?;
            decode_tail(codec, rest)
        }
    }
}

/// Decode one encoded tail (prefix already stripped): a v1 keyed
/// token only decodes with its key and fails closed without one
/// (#55); anything else is a legacy base64url tail, which always
/// decodes so pre-#55 routes keep working (dual decode). The query
/// and fragment are never payload for encoded tails (#20).
pub(crate) fn decode_tail(codec: &Codec, rest: &str) -> Option<String> {
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let bytes = b64u_decode(&rest[..end])?;
    if bytes.len() >= 17 && bytes[0] == 1 {
        return match codec {
            Codec::Keyed { key, .. } => keyed_decode(key, &bytes),
            _ => None,
        };
    }
    String::from_utf8(bytes).ok()
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

/* ---- keyed opaque routes (issue #55) -------------------------------- */

/// One SipHash-2-4 round, the reference schedule (veorq/SipHash): no
/// extra v2 rotation after v3 ^= v2 and no v0 rotation after
/// v3 ^= v0. The token format is pinned by interop tests on both
/// sides, so the PRF it rests on is pinned with it.
fn sipround(state: &mut [u64; 4]) {
    state[0] = state[0].wrapping_add(state[1]);
    state[1] = state[1].rotate_left(13);
    state[1] ^= state[0];
    state[0] = state[0].rotate_left(32);
    state[2] = state[2].wrapping_add(state[3]);
    state[3] = state[3].rotate_left(16);
    state[3] ^= state[2];
    state[0] = state[0].wrapping_add(state[3]);
    state[3] = state[3].rotate_left(21);
    state[3] ^= state[0];
    state[2] = state[2].wrapping_add(state[1]);
    state[1] = state[1].rotate_left(17);
    state[1] ^= state[2];
    state[2] = state[2].rotate_left(32);
}

/// SipHash-2-4 over `msg` with a 128-bit key (64-bit result).
fn siphash24(key: &[u8; 16], msg: &[u8]) -> u64 {
    let k0 = u64::from_le_bytes(key[..8].try_into().unwrap());
    let k1 = u64::from_le_bytes(key[8..].try_into().unwrap());
    let mut v = [
        k0 ^ 0x736f_6d65_7073_6575,
        k1 ^ 0x646f_7261_6e64_6f6d,
        k0 ^ 0x6c79_6765_6e65_7261,
        k1 ^ 0x7465_6462_7974_6573,
    ];
    let mut i = 0;
    while i + 8 <= msg.len() {
        let m = u64::from_le_bytes(msg[i..i + 8].try_into().unwrap());
        v[3] ^= m;
        sipround(&mut v);
        sipround(&mut v);
        v[0] ^= m;
        i += 8;
    }
    let mut last = (msg.len() as u64) << 56;
    for (j, b) in msg[i..].iter().enumerate() {
        last |= (*b as u64) << (8 * j);
    }
    v[3] ^= last;
    sipround(&mut v);
    sipround(&mut v);
    v[0] ^= last;
    v[2] ^= 0xff;
    sipround(&mut v);
    sipround(&mut v);
    sipround(&mut v);
    sipround(&mut v);
    v[0] ^ v[1] ^ v[2] ^ v[3]
}

/// Keystream block j of a token: SipHash over IV || u32le(j) || domain 3.
fn keystream_block(key: &[u8; 16], iv: &[u8], block: u32) -> [u8; 8] {
    let mut msg = Vec::with_capacity(iv.len() + 5);
    msg.extend_from_slice(iv);
    msg.extend_from_slice(&block.to_le_bytes());
    msg.push(3);
    siphash24(key, &msg).to_le_bytes()
}

/// Parse a base64url 16-byte route key. None on any mismatch: the
/// caller stays on the legacy codec, never a half-keyed state.
pub fn parse_key(s: &str) -> Option<[u8; 16]> {
    b64u_decode(s)?.try_into().ok()
}

/// Two SipHash MACs of the destination (domains 1 and 2) form the
/// token IV, binding it to the destination: decode verifies the IV
/// reproduces, so a wrong key or a tampered token fails closed.
fn dest_mac(key: &[u8; 16], dest: &[u8], dom: u8) -> [u8; 8] {
    let mut msg = dest.to_vec();
    msg.push(dom);
    siphash24(key, &msg).to_le_bytes()
}

/// Mint a v1 keyed token: 0x01 || IV(16) || dest XOR keystream.
pub(crate) fn keyed_token(key: &[u8; 16], dest: &[u8]) -> Vec<u8> {
    let iv = [dest_mac(key, dest, 1), dest_mac(key, dest, 2)].concat();
    let mut out = Vec::with_capacity(dest.len() + 17);
    out.push(1);
    out.extend_from_slice(&iv);
    for (j, b) in dest.iter().enumerate() {
        out.push(b ^ keystream_block(key, &iv, (j / 8) as u32)[j % 8]);
    }
    out
}

/// Decode a v1 keyed token body (prefix stripped, tail already
/// base64url-decoded). Fails closed (None) on: invalid UTF-8, an IV
/// that does not reproduce (wrong key, tamper) or a non-http(s)
/// destination - the engine routes nothing else. Mirrors keyedDecode
/// in app/src/codec.ts byte for byte.
fn keyed_decode(key: &[u8; 16], token: &[u8]) -> Option<String> {
    if token.len() < 17 || token[0] != 1 {
        return None;
    }
    let (iv, ct) = (&token[1..17], &token[17..]);
    let mut dest = Vec::with_capacity(ct.len());
    for (j, b) in ct.iter().enumerate() {
        dest.push(b ^ keystream_block(key, iv, (j / 8) as u32)[j % 8]);
    }
    let s = String::from_utf8(dest).ok()?;
    if iv[..8] != dest_mac(key, s.as_bytes(), 1) || iv[8..] != dest_mac(key, s.as_bytes(), 2) {
        return None;
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        return None;
    }
    Some(s)
}

/// RFC 3986 scheme: ALPHA followed by ALPHA / DIGIT / "+" / "-" / ".".
pub(crate) fn is_scheme(s: &str) -> bool {
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

    /// #55: keyed tokens round-trip, carry no destination in the
    /// clear, and fail closed without the key or under a wrong one.
    #[test]
    fn keyed_token_roundtrip() {
        let key: [u8; 16] = core::array::from_fn(|i| i as u8);
        let c = Codec::Keyed {
            prefix: "/j/".into(),
            key,
        };
        let dest = "https://example.com/path?q=1";
        let path = format!("/j/{}", b64u_encode(&keyed_token(&key, dest.as_bytes())));
        // Pinned interop with the TS codec (app/src/__tests__/codec.test.ts):
        // same key, same destination, same token string.
        assert_eq!(
            path,
            "/j/AfhHzGwm0S7HzQm7oCo2BuN_M9rWothiobfdMNe-Tw2pTYP-gQpzwm3EC7Hy"
        );
        assert_eq!(decode_path(&c, "", &path).unwrap(), dest);
        assert!(!path.contains("example.com"));
        // Wrong key fails closed.
        let wrong = Codec::Keyed {
            prefix: "/j/".into(),
            key: core::array::from_fn(|i| (i * 7 + 3) as u8),
        };
        assert_eq!(decode_path(&wrong, "", &path), None);
        // Without the key a token fails closed, not legacy-decoded.
        let plain = Codec::Base64Url {
            prefix: "/j/".into(),
        };
        assert_eq!(decode_path(&plain, "", &path), None);
    }

    /// #100: long-destination interop vector with the TS codec
    /// (app/src/__tests__/codec.test.ts): same key, same 639-byte
    /// destination, same token string. A long destination spans
    /// many keystream blocks, so the token format is pinned at that
    /// shape too.
    #[test]
    fn keyed_token_long_dest_vector() {
        let key: [u8; 16] = core::array::from_fn(|i| i as u8);
        let dest = format!("https://example.com/long/destination?q={}", "x".repeat(600));
        let path = format!("/j/{}", b64u_encode(&keyed_token(&key, dest.as_bytes())));
        assert_eq!(
            path,
            "/j/AS47tiqdnePs_GuktV3gabh1I7dgEuqPlNhBH2GbcqRVSbUAW5xQdtP-xoivMUG6t52dR9qQS9O_1DU52m5JAGevWIl1h2p82C3qjVN8DLdNdIANyUymea-ciGVtap50cm71MWS1rj6cP6lM33DONceehugrf61FZrkKk4xZ1AvEOM_HPp3mWvxoanyvBG60PHJfmvx7HG-PirksflE1r7EFl9vIpuuED7X57F-cjQgQmoBjmcQpOFL1KT6tEWV3SYKFwwKmu4UoG8D-b3kDL_SMR9Q2DQ8ViVAgULUxX-SZBnIfNTaFWJk2VZbh3KyoU41_4p_fjp71mNZ4phFRXfRLF9YihudeW7BDdIoECUkRyAdR4JssfOO_zcMQYjOE9XTbUiTL0Koc5SUYCO7XuyGUD_iwz7obIyh2W7eiF-nngmgISslYXaWqaJwquGg_g_1vrrJvcXiZgMP5IuJIzHNjmDD7-7-Bck5ECq4SPHJHtRvbNS4CLRdCuy_LMpGZfb6-Tzjx6HkHUeh4A8PZRyeJ9D9Tz-i7Y7atU0NF3s3Kd6bAlcCDR-TqbzQrl9wum7NYjC2_eRcSeGhuV8AaN4HoPhnTBeh9O7t7UmAGDaeL_swqj4NGdv8WjWznS9g6yfBSBZTxCZahs9snd0SHrZnSWSJI6jjADBb3ymamSBy5VLndWtTWolmJUn9DNFHIfu3utyVROmJsyTJ3YBaKqG94iIaNT9xyqvIhGKF0ODGMKIuA-Zfeoblzz7WAyHQHK2N0e5IMnovtIc19IfYyjxK4HhKrX_hGDmK3u-UFO8qbxz8EC_Sk613Ju_sOH9aurBB8L0a5sxM1NW0mpjfSbAsFypSkY_kE7FPIaAgWuEc"
        );
        let c = Codec::Keyed {
            prefix: "/j/".into(),
            key,
        };
        assert_eq!(decode_path(&c, "", &path).unwrap(), dest);
    }

    /// #55: dual decode - legacy tails still decode under the keyed
    /// codec, so routes minted before the key existed keep working.
    #[test]
    fn keyed_codec_decodes_legacy_tails() {
        let key: [u8; 16] = core::array::from_fn(|i| i as u8);
        let c = Codec::Keyed {
            prefix: "/j/".into(),
            key,
        };
        let dest = "https://example.com/x";
        let legacy = format!("/j/{}", b64u_encode(dest.as_bytes()));
        assert_eq!(decode_path(&c, "", &legacy).unwrap(), dest);
    }

    /// Pinned SipHash-2-4 reference vectors (veorq/SipHash test set):
    /// the token format is frozen, so the PRF is pinned with it.
    #[test]
    fn siphash_reference_vectors() {
        let key: [u8; 16] = core::array::from_fn(|i| i as u8);
        assert_eq!(siphash24(&key, &[]), 0x726fdb47dd0e0e31);
        assert_eq!(siphash24(&key, &[0x00]), 0x74f839c593dc67fd);
        assert_eq!(siphash24(&key, &[0x00, 0x01]), 0x0d6c8009d9a94f5a);
    }
}
