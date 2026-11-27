//! Single-source secret redaction (port of diag.ts
//! redactSecrets). Every diagnostic path in the engine app funnels
//! through the one TS function; this is its exact Rust twin, so
//! "what is a secret" has one definition and a testable, fuzzable
//! boundary. The seven passes run in the same order with the same
//! semantics as the TS regex chain; each is a single-pass linear
//! scanner (no regex engine, no backtracking), so the ReDoS class
//! the issue names is unrepresentable here by construction.
//!
//! JS \s is Unicode-aware, so the scanners match the exact
//! ECMAScript whitespace set (U+00A0, U+2028, U+3000 and friends
//! terminate values here exactly as they do in TS) and advance
//! one char per step, never one byte.
//!
//! Passes, in TS order (all ASCII-case-insensitive):
//!  1. URL userinfo: scheme://user:pass@ -> scheme://[redacted]@
//!  2. query secrets: [?&#]key=... for the oauth/captcha key set
//!  3. authorization + bearer/basic + token -> [redacted]
//!  4. authorization + any word -> [redacted]
//!  5. cookie + value (+ further name=value pairs) -> [redacted]
//!  6. bare bearer/basic + token -> [redacted]
//!  7. token/password/secret/api[_-]?key + value -> [redacted]

/// The ECMAScript \s class (WhiteSpace + LineTerminator + Zs +
/// U+FEFF), used where the TS regexes say \s or \S.
fn js_ws(ch: char) -> bool {
    matches!(
        ch,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// The separator class of passes 3-5 and 7: quote, apostrophe,
/// ECMAScript whitespace, colon, equals.
fn is_sep(ch: char) -> bool {
    ch == '"' || ch == '\'' || js_ws(ch) || ch == ':' || ch == '='
}

/// Length in bytes of the char starting with lead byte b.
fn char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// The char at byte offset k (k is always a char boundary here,
/// because every scanner advances by whole chars).
fn char_at(s: &str, k: usize) -> (char, usize) {
    let ch = s[k..].chars().next().unwrap();
    (ch, ch.len_utf8())
}

/// Redact secrets from any diagnostic string. Linear time, single
/// allocation per pass, identical output to the TS implementation.
pub fn redact_secrets(input: &str) -> String {
    let s = redact_url_userinfo(input);
    let s = redact_query_secrets(&s);
    let s = redact_authorization(&s);
    let s = keyword_value_pass(&s, &["authorization"], |ch| !js_ws(ch));
    let s = redact_cookie(&s);
    let s = redact_bearer_token(&s);
    keyword_value_pass(
        &s,
        &[
            "token", "password", "secret", "apikey", "api-key", "api_key",
        ],
        |ch| ch != '&' && ch != ';' && !js_ws(ch),
    )
}

fn is_scheme_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-'
}

/// Pass 1: ([a-z][a-z0-9+.-]*://)[^/\s@]+ -> $1[redacted]@
/// The JS match starts at the first ASCII letter of the scheme
/// run; a non-letter prefix (1http://) is copied through intact.
fn redact_url_userinfo(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0;
    while let Some(rel) = s[i..].find("://") {
        let colon = i + rel;
        let mut run = colon;
        while run > 0 && is_scheme_char(bytes[run - 1]) {
            run -= 1;
        }
        let mut start = run;
        while start < colon && !bytes[start].is_ascii_alphabetic() {
            start += 1;
        }
        if start < colon {
            let mut k = colon + 3;
            while k < bytes.len() {
                let (ch, l) = char_at(s, k);
                if ch == '/' || ch == '@' || js_ws(ch) {
                    break;
                }
                k += l;
            }
            if k > colon + 3 && bytes.get(k) == Some(&b'@') {
                out.push_str(&s[i..colon + 3]);
                out.push_str("[redacted]@");
                i = k + 1;
                continue;
            }
        }
        out.push_str(&s[i..colon + 3]);
        i = colon + 3;
    }
    out.push_str(&s[i..]);
    out
}

/// Pass 2: ([?&#]key=)[^&#\s]* -> $1[redacted]; the value may be
/// empty ("?code=" still redacts). The JS alternation backtracks
/// across keywords until one is followed by '=', which requiring
/// the '=' per candidate reproduces exactly.
fn redact_query_secrets(s: &str) -> String {
    const KEYS: [&str; 12] = [
        "code",
        "state",
        "nonce",
        "code_verifier",
        "id_token",
        "access_token",
        "refresh_token",
        "session_token",
        "credential",
        "g-recaptcha-response",
        "h-captcha-response",
        "cf-turnstile-response",
    ];
    let lower = s.to_ascii_lowercase();
    let lbytes = lower.as_bytes();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'?' || b == b'&' || b == b'#' {
            let mut matched = false;
            for key in KEYS {
                let end = i + 1 + key.len();
                if lbytes[i + 1..].starts_with(key.as_bytes()) && bytes.get(end) == Some(&b'=') {
                    let mut k = end + 1;
                    while k < bytes.len() {
                        let (ch, l) = char_at(s, k);
                        if ch == '&' || ch == '#' || js_ws(ch) {
                            break;
                        }
                        k += l;
                    }
                    out.push_str(&s[i..end + 1]);
                    out.push_str("[redacted]");
                    i = k;
                    matched = true;
                    break;
                }
            }
            if !matched {
                out.push(b as char);
                i += 1;
            }
        } else {
            let l = char_len(b);
            out.push_str(&s[i..i + l]);
            i += l;
        }
    }
    out
}

/// Authorization schemes whose credential follows after whitespace. A
/// scheme outside this set used to redact only the scheme word and
/// leave the credential ("Token abc123" -> "[redacted] abc123").
const AUTH_SCHEMES: [&str; 11] = [
    "bearer",
    "basic",
    "digest",
    "token",
    "negotiate",
    "ntlm",
    "apikey",
    "api-key",
    "aws4-hmac-sha256",
    "dpop",
    "vapid",
];

/// Pass 3: (authorization[sep]+)(scheme)\s+\S+ -> $1[redacted]
/// (the whole authorization value: redacting only the scheme word
/// would leave the credential in diagnostic text).
fn redact_authorization(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let lbytes = lower.as_bytes();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        if lbytes[i..].starts_with(b"authorization") {
            let mut j = i + 13;
            while j < bytes.len() {
                let (ch, l) = char_at(s, j);
                if !is_sep(ch) {
                    break;
                }
                j += l;
            }
            if j > i + 13 {
                let scheme_len = AUTH_SCHEMES
                    .iter()
                    .find(|sc| lbytes[j..].starts_with(sc.as_bytes()))
                    .map(|sc| sc.len());
                if let Some(sl) = scheme_len {
                    let mut k = j + sl;
                    while k < bytes.len() {
                        let (ch, l) = char_at(s, k);
                        if !js_ws(ch) {
                            break;
                        }
                        k += l;
                    }
                    if k > j + sl {
                        let tok_start = k;
                        while k < bytes.len() {
                            let (ch, l) = char_at(s, k);
                            if js_ws(ch) {
                                break;
                            }
                            k += l;
                        }
                        if k > tok_start {
                            out.push_str(&s[i..j]);
                            out.push_str("[redacted]");
                            i = k;
                            continue;
                        }
                    }
                }
            }
        }
        let l = char_len(bytes[i]);
        out.push_str(&s[i..i + l]);
        i += l;
    }
    out
}

/// Set-Cookie attribute names: a `; name=value` that starts with one
/// of these ends the cookie pairs (the attribute is not a secret).
const COOKIE_ATTRS: [&str; 9] = [
    "path",
    "domain",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly",
    "partitioned",
    "priority",
];

/// Byte offset past `; name=value` pairs starting at `j`, stopping at
/// a Set-Cookie attribute or a segment with no `=`. Mirrors
/// (?:;\s*(?!attr\b)[^;\s=]+=[^;\s]*)*.
fn skip_cookie_pairs(s: &str, lower: &str, mut j: usize) -> usize {
    let bytes = s.as_bytes();
    loop {
        if bytes.get(j) != Some(&b';') {
            return j;
        }
        let mut k = j + 1;
        while k < bytes.len() {
            let (ch, l) = char_at(s, k);
            if !js_ws(ch) {
                break;
            }
            k += l;
        }
        let is_attr = COOKIE_ATTRS.iter().any(|a| {
            lower[k..].starts_with(a)
                && !lower
                    .as_bytes()
                    .get(k + a.len())
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
        });
        if is_attr {
            return j;
        }
        let name_start = k;
        while k < bytes.len() {
            let (ch, l) = char_at(s, k);
            if ch == ';' || ch == '=' || js_ws(ch) {
                break;
            }
            k += l;
        }
        if k == name_start || bytes.get(k) != Some(&b'=') {
            return j;
        }
        k += 1;
        while k < bytes.len() {
            let (ch, l) = char_at(s, k);
            if ch == ';' || js_ws(ch) {
                break;
            }
            k += l;
        }
        j = k;
    }
}

/// Pass 5: (cookie[sep]+)[^;\s]+ then any further `; name=value`
/// pairs -> $1[redacted]. A Cookie request header carries many pairs;
/// redacting only the first leaked the rest.
fn redact_cookie(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let lbytes = lower.as_bytes();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        if lbytes[i..].starts_with(b"cookie") {
            let mut j = i + 6;
            while j < bytes.len() {
                let (ch, l) = char_at(s, j);
                if !is_sep(ch) {
                    break;
                }
                j += l;
            }
            if j > i + 6 {
                let vstart = j;
                while j < bytes.len() {
                    let (ch, l) = char_at(s, j);
                    if ch == ';' || js_ws(ch) {
                        break;
                    }
                    j += l;
                }
                if j > vstart {
                    let end = skip_cookie_pairs(s, &lower, j);
                    out.push_str(&s[i..vstart]);
                    out.push_str("[redacted]");
                    i = end;
                    continue;
                }
            }
        }
        let l = char_len(bytes[i]);
        out.push_str(&s[i..i + l]);
        i += l;
    }
    out
}

/// Passes 4 and 7: (keyword[sep]+)(value-class)+ -> $1[redacted]
/// One shared scanner: keyword, one-or-more separator chars, then
/// one-or-more value chars; on any failure the JS regex advances a
/// single position, which copying one char reproduces.
fn keyword_value_pass(s: &str, keywords: &[&str], is_value: impl Fn(char) -> bool) -> String {
    let lower = s.to_ascii_lowercase();
    let lbytes = lower.as_bytes();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        let mut hit = None;
        for kw in keywords {
            if lbytes[i..].starts_with(kw.as_bytes()) {
                hit = Some(*kw);
                break;
            }
        }
        if let Some(kw) = hit {
            let mut j = i + kw.len();
            while j < bytes.len() {
                let (ch, l) = char_at(s, j);
                if !is_sep(ch) {
                    break;
                }
                j += l;
            }
            if j > i + kw.len() {
                let vstart = j;
                while j < bytes.len() {
                    let (ch, l) = char_at(s, j);
                    if !is_value(ch) {
                        break;
                    }
                    j += l;
                }
                if j > vstart {
                    out.push_str(&s[i..vstart]);
                    out.push_str("[redacted]");
                    i = j;
                    continue;
                }
            }
        }
        let l = char_len(bytes[i]);
        out.push_str(&s[i..i + l]);
        i += l;
    }
    out
}

/// Pass 6: ((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+ -> $1[redacted]
fn redact_bearer_token(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let lbytes = lower.as_bytes();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        let kw_len = if lbytes[i..].starts_with(b"bearer") {
            Some(6)
        } else if lbytes[i..].starts_with(b"basic") {
            Some(5)
        } else {
            None
        };
        if let Some(kl) = kw_len {
            let mut k = i + kl;
            while k < bytes.len() {
                let (ch, l) = char_at(s, k);
                if !js_ws(ch) {
                    break;
                }
                k += l;
            }
            if k > i + kl {
                let tok_start = k;
                while k < bytes.len() {
                    let (ch, l) = char_at(s, k);
                    if !(ch.is_ascii_alphanumeric()
                        || matches!(ch, '.' | '_' | '~' | '+' | '/' | '=' | '-'))
                    {
                        break;
                    }
                    k += l;
                }
                if k > tok_start {
                    out.push_str(&s[i..tok_start]);
                    out.push_str("[redacted]");
                    i = k;
                    continue;
                }
            }
        }
        let l = char_len(bytes[i]);
        out.push_str(&s[i..i + l]);
        i += l;
    }
    out
}
