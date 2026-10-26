//! Targeted JS URL string-literal rewriting. No AST, by design: scan
//! string literals ('...', "...", backtick-quoted) and rewrite the ones
//! that look like URLs (scheme-absolute http(s)/ws(s) or protocol-relative).
//! Relative literals are left alone: the runtime bootstrap and the SW
//! resolve those at request time. URL literals stay scan-based by
//! design, but #235 shipped the one AST pass the runtime needed
//! (js/globals.rs: location reads -> the #236 virtual location);
//! a general AST rewrite remains unscheduled (#146).

/// #449: does this script body pin its generated URLs to an origin
/// with an anchored regex (a `/^https?:.../` literal or a
/// `RegExp("...")` source beginning `^https?:` / `^https?:\:`)? Such
/// loaders sanity-validate the URLs they build (gapi's "Bad hint:
/// failed sanity", LobsterBrowse #154): a route token fails the pin
/// and the loader throws before any fetch. The scan is a plain
/// substring match on the raw body - the needles are regex-specific
/// byte sequences, and a false positive only skips the literal pass
/// (the runtime seams still route every request), so the failure
/// direction is safe.
pub fn has_origin_pinning_regex(js: &str) -> bool {
    js.contains("^https?:") || js.contains("^https?\\:")
}

/// Rewrite URL-like string literals in a <script> body.
pub fn rewrite_script(js: &str, enc: &dyn Fn(&str) -> String) -> String {
    // #449: an origin-pinning body keeps its URL literals verbatim:
    // the loader validates the URLs it builds. The callers still run
    // their other passes (frame-buster neutralization, #235 globals)
    // over the body.
    if has_origin_pinning_regex(js) {
        return js.to_string();
    }
    rewrite_literals(js, enc, true)
}

/// Rewrite URL-like string literals in an inline event handler value.
pub fn rewrite_inline(js: &str, enc: &dyn Fn(&str) -> String) -> String {
    rewrite_literals(js, enc, false)
}

/// Regex-vs-division disambiguation: the longest keyword that can
/// precede a regex literal ("instanceof"); anything longer is an
/// identifier and cannot be one of these.
pub(crate) const MAX_KEYWORD: usize = 11;

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
    // #345: was the last identifier run a property name (after '.')?
    // a.in / obj.do are member accesses, never regex-position
    // keywords.
    let mut w_member = false;
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
        if c == b'/' && regex_allowed(last_sig, &word[..wlen], w_member) {
            if let Some(close) = find_regex_end(&js[i + 1..]) {
                out.push_str(&js[i..i + 1 + close + 1]);
                i += 1 + close + 1;
                last_sig = b'x'; // a regex literal is a value
                wlen = 0;
                w_member = false;
                continue;
            }
            // No closing '/' before a line break: not a regex. The
            // probed bytes were only looked at, nothing pushed yet;
            // fall through and treat this '/' as division.
        }
        let is_quote = c == b'"' || c == b'\'' || (allow_template && c == 96u8);
        if is_quote {
            let q = c as char;
            // #176: a template literal is ONE token, substitutions
            // included: its text is never code, so a '//' or quote in
            // template text must not restart the scanner and
            // suppress rewriting for the rest of the line. The old
            // scanner bailed on '${', which did exactly that.
            let close = if q == '\u{60}' {
                find_template_end(&js[i + 1..])
            } else {
                find_literal_end(&js[i + 1..], q)
            };
            if let Some(close) = close {
                let inner = &js[i + 1..i + 1 + close];
                // #75: JSON-embedded URLs spell the slashes escaped
                // (backslash-slash), e.g. google image tiles and
                // most JSON blobs. Undo that one escape before
                // classifying; anything else stays untouched
                // (conservative default).
                let unesc = json_unescape(inner);
                let probe = unesc.as_deref().unwrap_or(inner);
                // A template with substitutions is dynamic: encoding
                // its text would freeze '${...}' into a static
                // route.
                let dyn_tmpl = q == '\u{60}' && inner.contains("${");
                if !dyn_tmpl && looks_like_url(probe) {
                    out.push(q);
                    if let Some(u) = unesc {
                        out.push_str(&enc(u.trim()));
                    } else {
                        out.push_str(&rewrite_quoted_body(inner, enc));
                    }
                    out.push(q);
                } else if !dyn_tmpl && unesc.is_none() && looks_like_rel_asset(inner) {
                    // #131: never route escaped literals (the same
                    // rule as rewrite_quoted_body - broken JS is
                    // worse than a missed rewrite the runtime paths
                    // still recover).
                    out.push(q);
                    out.push_str(&enc(inner.trim()));
                    out.push(q);
                } else {
                    out.push_str(&js[i..i + 1 + close + 1]);
                }
                i += 1 + close + 1;
                last_sig = b'x'; // a string literal is a value
                wlen = 0;
                w_member = false;
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
            // Module specifiers (#126): 'from "..."' and 'import
            // "..."' / 'import("...")' inside an inline script resolve
            // against the document's engine route at fetch time, and
            // the SW cannot recover the destination from the resolved
            // engine-origin path. Route non-bare specifiers here with
            // the same bare rule as the TS pass (routeModuleSpecifier
            // in app/src/worker-imports.ts): package names pass
            // through; scheme, root- and dot-relative specifiers
            // route. The '.' guard excludes property access
            // (x.from("..."), cfg.import("...")).
            if (run == "from" || run == "import") && last_sig != b'.' {
                if let Some((open_end, spec, q, end)) = peek_specifier(js, i, run == "import") {
                    if !spec.contains('\\') && !is_bare_specifier(&spec) {
                        out.push_str(&js[i..open_end]);
                        out.push_str(&enc(&spec));
                        out.push(q);
                        i = end;
                        last_sig = b'x'; // a string literal is a value
                        wlen = 0;
                        w_member = false;
                        continue;
                    }
                }
            }
            if run.len() <= MAX_KEYWORD {
                word[..run.len()].copy_from_slice(run.as_bytes());
                wlen = run.len();
                // #345: last_sig is still the sig BEFORE this run,
                // so '.' here means property access, not a keyword.
                w_member = last_sig == b'.';
            } else {
                wlen = 0; // too long to be a keyword
                w_member = false;
            }
            last_sig = b'x';
            continue;
        }
        let ch_len = utf8_len(c);
        out.push_str(&js[i..(i + ch_len).min(js.len())]);
        i += ch_len;
        match c {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c => {} // keep last_sig
            // #206: postfix ++/-- ENDS an expression, so the '/'
            // after it is division, never a regex start.
            b'+' if last_sig == b'+' => last_sig = b'x',
            b'-' if last_sig == b'-' => last_sig = b'x',
            _ => {
                last_sig = c;
                wlen = 0;
                w_member = false;
            }
        }
    }
    out
}

/// Peek past an identifier run ('from'/'import') for a module
/// specifier string: skip whitespace and, for dynamic import, one
/// opening paren plus whitespace. Returns the offset just past the
/// opening quote, the specifier text, the quote char, and the offset
/// just past the closing quote.
fn peek_specifier(
    js: &str,
    from: usize,
    allow_paren: bool,
) -> Option<(usize, String, char, usize)> {
    let b = js.as_bytes();
    let mut p = from;
    while p < b.len() && matches!(b[p], b' ' | b'\t' | b'\n' | b'\r') {
        p += 1;
    }
    if allow_paren && p < b.len() && b[p] == b'(' {
        p += 1;
        while p < b.len() && matches!(b[p], b' ' | b'\t' | b'\n' | b'\r') {
            p += 1;
        }
    }
    if p >= b.len() || (b[p] != b'"' && b[p] != b'\'') {
        return None;
    }
    let q = b[p] as char;
    let close = find_literal_end(&js[p + 1..], q)?;
    let spec = js[p + 1..p + 1 + close].to_string();
    Some((p + 1, spec, q, p + 1 + close + 1))
}

/// Bare module specifier (node-style package name): no scheme, not
/// root- or dot-relative. Mirrors routeModuleSpecifier in
/// app/src/worker-imports.ts: bare specifiers belong to the runtime
/// import map and pass through untouched.
fn is_bare_specifier(spec: &str) -> bool {
    let s = spec.trim();
    if s.starts_with('/') || s.starts_with('.') {
        return false;
    }
    if let Some(ci) = s.find(':') {
        if crate::encode::is_scheme(&s[..ci]) {
            return false;
        }
    }
    true
}

/// Can a '/' at this position start a regex literal? False positives
/// are harmless: the span is copied verbatim, so the worst case is a
/// missed literal rewrite (the runtime bootstrap catches those at
/// request time). False negatives corrupt the script.
pub(crate) fn regex_allowed(last_sig: u8, last_word: &[u8], word_member: bool) -> bool {
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
    // #345: an identifier after '.' is a property name (a.in,
    // obj.do), never one of these keywords.
    if !word_member && KEYWORDS.contains(&last_word) {
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
pub(crate) fn find_regex_end(s: &str) -> Option<usize> {
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
/// #153: www.w3.org hosts identity URIs, never fetched resources - the
/// XML namespace constants (createElementNS/setAttributeNS/lookupPrefix:
/// "http://www.w3.org/2000/svg", ".../1999/xlink", ".../2000/xmlns/",
/// MathML, RDF) live in bundled JS as plain string literals. Minting a
/// route for one silently changes the namespace argument, createElementNS
/// then builds a plain Element with no .style and React dies mid-commit
/// (excalidraw's "setting 'width'" + provider cascade); setAttributeNS
/// throws NamespaceError the same way (delta.com's Tealeaf). No real app
/// fetches w3.org as a subresource, so the host is excluded wholesale.
fn looks_like_url(s: &str) -> bool {
    let t = s.trim();
    if t.contains(' ') {
        return false;
    }
    // A userinfo-bearing URI can be application configuration (for example,
    // a telemetry DSN). Changing its authority to an opaque engine route
    // corrupts parsers before a browser-owned request is ever made.
    let authority = t
        .split_once("://")
        .map(|(_, rest)| rest)
        .or_else(|| t.strip_prefix("//"));
    if authority.is_some_and(|a| {
        a.split(['/', '?', '#'])
            .next()
            .is_some_and(|host| host.contains('@'))
    }) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("http://www.w3.org/") || lower.starts_with("https://www.w3.org/") {
        return false;
    }
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

/// #131: dot-relative web-asset literals. Bundlers ship dependency
/// maps as plain string arrays (Vite's __vite__mapDeps:
/// "../chunks/x.js", "./app.css"), and the runtime resolves them
/// against the module's URL before any fetch or import - the SW only
/// ever sees an engine-origin path that every referrer-based recovery
/// resolves against the wrong base (the document, not the module).
/// Route them like absolute URL literals: enc resolves against the
/// serving script's own base. ponytail: the gate is a dot prefix plus
/// a static web-asset extension, no whitespace, no escapes; root-
/// relative and bare filenames stay untouched (document-base
/// resolution at runtime + the bootstrap fetch wrapper are correct
/// there). Widen the extension list only on a live site that needs
/// it - a string that merely looks like an asset path but is used in
/// equality or string surgery is the false-positive ceiling.
fn looks_like_rel_asset(s: &str) -> bool {
    // Whitespace gate sees the raw literal: a padded string stays
    // untouched instead of being trimmed into a route.
    if s.chars().any(|c| c.is_ascii_whitespace()) || s.contains('\\') {
        return false;
    }
    if !(s.starts_with("./") || s.starts_with("../")) {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    [".js", ".mjs", ".css", ".wasm"]
        .iter()
        .any(|e| lower.ends_with(e))
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
/// #176: scan a template literal (past its opening backtick) to the
/// closing backtick. Template TEXT is never code: quotes and
/// comment-looking slashes inside it stay text. '${' opens a
/// substitution, which is code and is scanned for braces, strings
/// and nested templates. None when unterminated.
fn find_template_end(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'`' => return Some(i),
            b'$' if i + 1 < b.len() && b[i + 1] == b'{' => {
                i = find_substitution_end(s, i + 2)?;
            }
            _ => i += 1,
        }
    }
    None
}

/// Offset just past the '}' that closes a '${' substitution opened
/// before s[start..]. Brace depth, string literals and nested
/// templates are all tracked; None when unterminated.
fn find_substitution_end(s: &str, start: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = start;
    let mut depth = 1usize;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'\'' | b'"' => {
                let q = b[i];
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' {
                        i += 2;
                    } else if b[i] == q {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            b'`' => {
                i += find_template_end(&s[i + 1..])? + 2;
            }
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
    fn w3_namespace_uris_are_identity_not_urls() {
        // #153: namespace constants must survive verbatim or
        // createElementNS builds a plain Element and the app dies.
        let js = r#"var ns="http://www.w3.org/2000/svg";var xl='http://www.w3.org/1999/xlink';var m="http://www.w3.org/1998/Math/MathML";document.createElementNS(ns,"svg");fetch("https://api.example.com/x");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""http://www.w3.org/2000/svg""#), "{}", out);
        assert!(out.contains(r#"'http://www.w3.org/1999/xlink'"#), "{}", out);
        assert!(
            out.contains(r#""http://www.w3.org/1998/Math/MathML""#),
            "{}",
            out
        );
        assert!(out.contains(r#""[https://api.example.com/x]""#), "{}", out);
    }

    #[test]
    fn credential_bearing_configuration_urls_remain_parseable() {
        // #499: the Sentry-style DSN is parsed as configuration, not fetched.
        // A real browser-owned fetch in the same script must still route.
        let js = r#"const dsn = "https://publickey@telemetry.example/42";
            const config = new URL(dsn);
            fetch("https://api.example/score");"#;
        let out = rewrite_script(js, &|u| format!("[{u}]"));
        assert!(
            out.contains(r#""https://publickey@telemetry.example/42""#),
            "{out}"
        );
        assert!(
            out.contains(r#"fetch("[https://api.example/score]")"#),
            "{out}"
        );

        // This is a URL-structure rule, not a Sentry or site-specific patch.
        let other = r#"const cfg = new URL("wss://user:pass@config.example/socket");
            const target = "//name@config.example/options";"#;
        assert_eq!(rewrite_script(other, &|u| format!("[{u}]")), other);
    }

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
    fn member_access_keyword_names_stay_division() {
        // #345: a.in / obj.do are property accesses, not keywords;
        // treating them as regex-position keywords swallowed the
        // rest of the line as a regex body and left URL literals
        // unrewritten.
        let js = "x = a.in / 2; u = \"https://cdn.x.com/a.js\"; z = w.do / 3; v = \"https://cdn.y.com/b.js\";";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("[https://cdn.x.com/a.js]"), "{}", out);
        assert!(out.contains("[https://cdn.y.com/b.js]"), "{}", out);
        assert!(out.contains("a.in / 2"), "division preserved: {}", out);
        assert!(out.contains("w.do / 3"), "division preserved: {}", out);
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

    #[test]
    fn module_specifiers_route() {
        // #126: static, dynamic and export-from specifiers route when
        // they are not bare package names; the closing quote is
        // consumed so the literal pass never double-processes them.
        let js = r#"import './a.js'; import b from "../b.js"; import("/root.js"); export {x} from 'https://cdn.example.com/m.js';"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r"'[./a.js]'"), "{}", out);
        assert!(out.contains(r#""[../b.js]""#), "{}", out);
        assert!(out.contains(r#""[/root.js]""#), "{}", out);
        assert!(out.contains(r"'[https://cdn.example.com/m.js]'"), "{}", out);
    }

    #[test]
    fn bare_specifiers_stay_bare() {
        // Bare package names belong to the runtime import map; the
        // rewriter must not touch them (routeModuleSpecifier parity).
        let js = r#"import 'lodash'; import x from "react-dom/client"; import('some-pkg/x');"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    #[test]
    fn import_meta_and_property_access_untouched() {
        // import.meta: no string follows the token. x.from(...) and
        // cfg.import(...): the '.' guard excludes property access.
        let js = "import.meta.url; const u = x.from('./keep'); cfg.import('pkg/x');";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    #[test]
    fn twitch_concat_shape_stays_verbatim() {
        // #124 regression shape: the tokens around a string-concat
        // chain must not be bridged by the specifier pass either.
        let js = r#"x="No matches from ".concat(w," payloads"); import 'https://x.example/a.js';"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("No matches from "), "{}", out);
        assert!(out.contains(".concat(w,"), "{}", out);
        assert!(out.contains(r"'[https://x.example/a.js]'"), "{}", out);
    }

    #[test]
    fn rel_asset_literals_route() {
        // #131: bundler dependency maps carry dot-relative asset
        // paths as plain strings (Vite __vite__mapDeps); they must
        // route at serve time exactly like absolute URL literals.
        let js = r#"m.f||(m.f=["../nodes/0.A.js","./a.css","../b/x.mjs"]);"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[../nodes/0.A.js]""#), "{}", out);
        assert!(out.contains(r#""[./a.css]""#), "{}", out);
        assert!(out.contains(r#""[../b/x.mjs]""#), "{}", out);
    }

    #[test]
    fn rel_asset_gates_stay_conservative() {
        // No dot prefix, no web-asset extension, whitespace, escapes:
        // every one of those stays verbatim (the runtime referrer
        // recovery still handles genuine fetch-time relatives).
        let js = r#"var a="x.js",b="../api/data",c="./y\n.js",d="../z.txt",e=" ./q.js";"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    /// #176: template text is never code: the '//' inside the
    /// template must not start a comment that suppresses rewriting
    /// for the rest of the line.
    #[test]
    fn template_literal_text_is_never_code() {
        let js = "var a=`${p}//${h}`;var u=\"https://t.example/x\";";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://t.example/x]""#), "{}", out);
        assert!(out.contains("//"), "template text intact: {}", out);
    }

    /// #176: a substitution-free URL template rewrites like a quoted
    /// literal; a template WITH substitutions stays verbatim (its
    /// text is dynamic).
    #[test]
    fn template_literal_url_text_rewrites() {
        let js = "var a=`https://t.example/t`;";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains("`[https://t.example/t]`"), "{}", out);
        let js = "var b=`https://${h}/x`;";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js);
    }

    /// #449: a gapi-shaped loader validates the URLs it builds
    /// against an anchored origin-pinning regex. The whole literal
    /// pass must skip that body: with the rewritten output exactly
    /// as authored, the loader's own sanity check passes.
    #[test]
    fn origin_pinned_script_keeps_url_literals_verbatim() {
        let js = r#"var va=/^https?:\/\//;var u="https://a.example.com/x";if(!va.test(u))throw new Error("Bad hint: failed sanity");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(out, js, "pinned body changed at all: {}", out);
        assert!(
            !out.contains("[https://a.example.com"),
            "route token in pinned body: {}",
            out
        );
    }

    /// #449: the trigger fires from a RegExp(...) constructor string
    /// and the escaped-colon spelling; a plain body and an anchored
    /// regex without the s-quantifier (the measured-table control)
    /// stay untouched.
    #[test]
    fn origin_pinning_trigger_forms() {
        assert!(
            has_origin_pinning_regex(r#"new RegExp("^https?:\\/[a-z]+\\.example\\.com")"#),
            "RegExp string form not detected"
        );
        assert!(
            has_origin_pinning_regex(r#"var va=/^https?:\:\/\//;"#),
            "escaped-colon form not detected"
        );
        assert!(
            !has_origin_pinning_regex(r#"var u="https://plain.example.com/x";fetch(u);"#),
            "plain body false positive"
        );
        assert!(
            !has_origin_pinning_regex(r#"var va=new RegExp("^https://apis.google.com/");"#),
            "no-quantifier anchored regex false positive"
        );
    }

    /// #449: the skip is whole-script by design: a pinned body's
    /// ordinary fetch literals stay plaintext too (a per-literal skip
    /// would break comparisons that work today); the runtime seams,
    /// not the literal pass, keep those requests on the engine.
    #[test]
    fn pinned_skip_is_script_level() {
        let js = r#"var va=/^https?:\/\//;fetch("https://other.example.com/b");"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert_eq!(
            out, js,
            "ordinary literal rewritten inside a pinned body: {}",
            out
        );
    }

    /// #449 acceptance: a script without the pinning regex rewrites
    /// exactly as before.
    #[test]
    fn unpinned_script_rewrites_as_before() {
        let js = r#"var u="https://plain.example.com/x";fetch(u);"#;
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(
            out.contains(r#""[https://plain.example.com/x]""#),
            "plain literal not rewritten: {}",
            out
        );
    }

    /// #206: postfix ++/-- ends the expression, so the '/' after it
    /// is division; the regex misparse used to swallow the rest of
    /// the line and suppress literal rewriting.
    #[test]
    fn postfix_increment_slash_is_division() {
        let js = "a++ / b; var u=\"https://t.example/x\"; c / d;";
        let out = rewrite_script(js, &|u| format!("[{}]", u));
        assert!(out.contains(r#""[https://t.example/x]""#), "{}", out);
        assert!(out.contains("a++ / b"), "{}", out);
    }
}
