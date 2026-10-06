//! Targeted JS URL string-literal rewriting. No AST, by design: scan
//! string literals ('...', "...", backtick-quoted) and rewrite the ones
//! that look like URLs (scheme-absolute http(s)/ws(s) or protocol-relative).
//! Relative literals are left alone: the runtime bootstrap and the SW
//! resolve those at request time. Full AST rewriting (oxc) is Phase 3
//! and only if the compat suite proves this pass insufficient.

/// Rewrite URL-like string literals in a <script> body.
pub fn rewrite_script(js: &str, enc: &dyn Fn(&str) -> String) -> String {
    rewrite_literals(js, enc, true)
}

/// Rewrite URL-like string literals in an inline event handler value.
pub fn rewrite_inline(js: &str, enc: &dyn Fn(&str) -> String) -> String {
    rewrite_literals(js, enc, false)
}

fn rewrite_literals(js: &str, enc: &dyn Fn(&str) -> String, allow_template: bool) -> String {
    let mut out = String::with_capacity(js.len() + 64);
    let b = js.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        // Comments: skip verbatim (never rewrite inside comments).
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            if let Some(nl) = js[i..].find('\n') {
                out.push_str(&js[i..i + nl]);
                i += nl;
                continue;
            } else {
                out.push_str(&js[i..]);
                break;
            }
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            if let Some(end) = js[i + 2..].find("*/") {
                out.push_str(&js[i..i + 2 + end + 2]);
                i += 2 + end + 2;
                continue;
            } else {
                out.push_str(&js[i..]);
                break;
            }
        }
        let is_quote = c == b'"' || c == b'\'' || (allow_template && c == 96u8);
        if is_quote {
            let q = c as char;
            if let Some(close) = find_literal_end(&js[i + 1..], q) {
                let inner = &js[i + 1..i + 1 + close];
                // #75: JSON-embedded URLs spell the slashes escaped
                // (backslash-slash), e.g. google image tiles and
                // most JSON blobs. Undo that one escape before
                // classifying; anything else stays untouched
                // (conservative default).
                let unesc = json_unescape(inner);
                let probe = unesc.as_deref().unwrap_or(inner);
                if looks_like_url(probe) {
                    out.push(q);
                    if let Some(u) = unesc {
                        out.push_str(&enc(u.trim()));
                    } else {
                        out.push_str(&rewrite_quoted_body(inner, enc));
                    }
                    out.push(q);
                } else {
                    out.push_str(&js[i..i + 1 + close + 1]);
                }
                i += 1 + close + 1;
                continue;
            }
        }
        let ch_len = utf8_len(c);
        out.push_str(&js[i..(i + ch_len).min(js.len())]);
        i += ch_len;
    }
    out
}

/// A URL-like literal: absolute http(s)/ws(s) URL, or protocol-relative.
fn looks_like_url(s: &str) -> bool {
    let t = s.trim();
    if t.contains(' ') {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ws://")
        || lower.starts_with("wss://")
    {
        return true;
    }
    // Protocol-relative: //host/path, but not a plain "//" or "//" inside
    // empty strings.
    t.starts_with("//") && t.len() > 3 && t.as_bytes()[2].is_ascii_alphanumeric()
}

/// #75: the JSON escaped-slash form. Undo it only when it is the sole
/// escape form in the literal; any other backslash sequence returns
/// None (the literal is left untouched by the caller).
fn json_unescape(inner: &str) -> Option<String> {
    if !inner.contains("\\/") {
        return None;
    }
    let u = inner.replace("\\/", "/");
    if u.contains('\\') {
        return None;
    }
    Some(u)
}

/// Escaping: if the original literal contained no escapes, the rewrite is
/// plain. If it did (rare for URLs), leave the literal untouched: broken
/// JS is worse than an un-rewritten URL, and the runtime bootstrap still
/// catches most of these at request time.
fn rewrite_quoted_body(inner: &str, enc: &dyn Fn(&str) -> String) -> String {
    if inner.contains('\\') {
        return inner.to_string();
    }
    enc(inner.trim())
}

fn find_literal_end(s: &str, q: char) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2, // escape: skip next byte
            c if c == q as u8 => return Some(i),
            // Template literals: ${...} may contain nested quotes; bail
            // on templates containing ${ to stay conservative.
            b'$' if q == 96u8 as char && i + 1 < b.len() && b[i + 1] == b'{' => return None,
            _ => i += 1,
        }
    }
    None
}

fn utf8_len(b: u8) -> usize {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_url_literals_only() {
        let js =
            r#"var a = "https://example.com/x"; var b = 'hello'; fetch("//cdn.example.net/y");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://example.com/x]""#), "{}", out);
        assert!(out.contains("'hello'"));
        // Protocol-relative literals are rewritten as-is: absolutizing
        // them is the enc callback's job (it knows the page scheme).
        assert!(out.contains(r#""[//cdn.example.net/y]""#), "{}", out);
    }

    #[test]
    fn ignores_comments_and_nonurls() {
        let js = "// 'https://keep.example/'\nvar s = 'not a url with spaces';";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("https://keep.example/"));
        assert!(out.contains("not a url with spaces"));
    }

    #[test]
    fn json_escaped_url_literals_rewrite() {
        // #75: the JSON escaped-slash form is how JSON-embedded URLs
        // spell slashes; the escaped form is now rewritten, not
        // skipped.
        let js = r#"var a = "https:\/\/escaped.example/x";"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://escaped.example/x]""#), "{}", out);
    }

    #[test]
    fn other_escapes_still_untouched() {
        // Any escape other than the JSON escaped-slash form
        // disqualifies the literal: broken JS is worse than an
        // un-rewritten URL.
        let js = "var a = \"https:\\nother.example/x\";";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("https:\\nother.example/x"), "{}", out);
    }

    #[test]
    fn new_url_constructor_literal_rewrites() {
        // #75: new URL(...) first-argument literals are ordinary
        // quoted literals; the pass already covers them. Pinned
        // here so the coverage claim is tested, not remembered.
        let js = r#"const u = new URL("https://dyn.example/p?x=1");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://dyn.example/p?x=1]""#), "{}", out);
    }
}
