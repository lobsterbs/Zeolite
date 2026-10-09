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

/// Regex-vs-division disambiguation: the longest keyword that can
/// precede a regex literal ("instanceof"); anything longer is an
/// identifier and cannot be one of these.
const MAX_KEYWORD: usize = 11;

fn rewrite_literals(js: &str, enc: &dyn Fn(&str) -> String, allow_template: bool) -> String {
    let mut out = String::with_capacity(js.len() + 64);
    let b = js.as_bytes();
    let mut i = 0;
    // Regex/division state: last significant byte and last short
    // identifier run. A '/' starts a regex literal only where an
    // expression cannot have just ended.
    let mut last_sig: u8 = b';';
    let mut word = [0u8; MAX_KEYWORD];
    let mut wlen = 0usize;
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
        // Regex literal: copy the body verbatim. A quote inside a
        // regex is a pattern character, not a string delimiter; in
        // YouTube's base.js a messageRegExp embeds a quoted URL, and
        // rewriting it injected '/' characters from the engine route
        // that terminated the pattern early and broke the whole
        // script's parse (#122).
        if c == b'/' && regex_allowed(last_sig, &word[..wlen]) {
            if let Some(close) = find_regex_end(&js[i + 1..]) {
                out.push_str(&js[i..i + 1 + close + 1]);
                i += 1 + close + 1;
                last_sig = b'x'; // a regex literal is a value
                wlen = 0;
                continue;
            }
            // No closing '/' before a line break: not a regex. The
            // probed bytes were only looked at, nothing pushed yet;
            // fall through and treat this '/' as division.
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
                last_sig = b'x'; // a string literal is a value
                wlen = 0;
                continue;
            }
        }
        // Identifier runs feed the keyword check in regex_allowed.
        if c == b'_' || c == b'$' || c.is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < b.len() && (b[i] == b'_' || b[i] == b'$' || b[i].is_ascii_alphanumeric()) {
                i += 1;
            }
            out.push_str(&js[start..i]);
            let run = &js[start..i];
            if run.len() <= MAX_KEYWORD {
                word[..run.len()].copy_from_slice(run.as_bytes());
                wlen = run.len();
            } else {
                wlen = 0; // too long to be a keyword
            }
            last_sig = b'x';
            continue;
        }
        let ch_len = utf8_len(c);
        out.push_str(&js[i..(i + ch_len).min(js.len())]);
        i += ch_len;
        match c {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c => {} // keep last_sig
            _ => {
                last_sig = c;
                wlen = 0;
            }
        }
    }
    out
}

/// Can a '/' at this position start a regex literal? False positives
/// are harmless: the span is copied verbatim, so the worst case is a
/// missed literal rewrite (the runtime bootstrap catches those at
/// request time). False negatives corrupt the script.
fn regex_allowed(last_sig: u8, last_word: &[u8]) -> bool {
    const KEYWORDS: [&[u8]; 13] = [
        b"return",
        b"typeof",
        b"instanceof",
        b"in",
        b"of",
        b"new",
        b"delete",
        b"void",
        b"case",
        b"do",
        b"else",
        b"throw",
        b"yield",
    ];
    if KEYWORDS.contains(&last_word) {
        return true;
    }
    matches!(
        last_sig,
        b'(' | b','
            | b'='
            | b':'
            | b'['
            | b'!'
            | b'&'
            | b'|'
            | b'?'
            | b'{'
            | b'}'
            | b';'
            | b'+'
            | b'-'
            | b'*'
            | b'%'
            | b'^'
            | b'<'
            | b'>'
            | b'~'
    )
}

/// Byte offset of the closing '/' of a regex body, scanning
/// conservatively: an unescaped line break means this was not a
/// regex, and a '/' inside a character class does not close it.
fn find_regex_end(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut in_class = false;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'[' => {
                in_class = true;
                i += 1;
            }
            b']' => {
                in_class = false;
                i += 1;
            }
            b'\n' | b'\r' => return None,
            b'/' if !in_class => return Some(i),
            _ => i += 1,
        }
    }
    None
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
            // Template literals: a dollar-brace substitution may
            // contain nested quotes; bail to stay conservative.
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
    fn regex_bodies_are_verbatim() {
        // #122: a regex matching a Firefox error message embeds a
        // quoted URL (YouTube base.js). The quote inside the regex is
        // a pattern character; rewriting the URL injected '/' from the
        // engine route, terminated the pattern early, and broke the
        // whole script's parse.
        let js = r#"{messageRegExp:/Blocked a frame with origin "https://www.youtube.com" from accessing a cross-origin frame.*/,weight:500}"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    #[test]
    fn regexes_do_not_shadow_string_rewrites() {
        let js = r#"var re = /"https:\/\/keep\.example\/"/; fetch("https://rewrite.example/x");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://rewrite.example/x]""#), "{}", out);
        assert!(out.contains(r#"/"https:\/\/keep\.example\/"/"#), "{}", out);
    }

    #[test]
    fn regex_after_punct_and_keywords() {
        let js = "a = (/x/.test(s)); b = typeof /y/;";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    #[test]
    fn division_stays_division() {
        let js = "var x = a / b / c; var y = (p + q) / 2;";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    #[test]
    fn regex_char_class_slash_and_escapes() {
        let js = "var re = /a[/]b\\/c/g; var s = 'https://after.example/ok';";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("/a[/]b\\/c/g"), "{}", out);
        assert!(out.contains(r#"'[https://after.example/ok]'"#), "{}", out);
    }

    #[test]
    fn unterminated_pseudo_regex_recovers_next_line() {
        // '++' puts the scanner in regex-allowed state, but no '/'
        // closes on that line: the probe must bail at the newline and
        // keep rewriting literals on the next line.
        let js = "var x = a++ / b\nvar s = \"https://next.example/y\";";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://next.example/y]""#), "{}", out);
        assert!(out.contains("a++ / b"), "{}", out);
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
        let js = "var a = \"https:\\\\nother.example/x\";";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("https:\\\\nother.example/x"), "{}", out);
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
