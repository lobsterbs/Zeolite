//! Streaming CSS url() rewriting for <style> blocks, inline style
//! attributes and standalone stylesheets. One scan, two faces:
//! - `rewrite_stylesheet`: one-shot over a complete string (style
//!   blocks are raw-text within the HTML stream anyway);
//! - `CssRewriter`: incremental, for streamed stylesheet bodies. Only
//!   the potentially incomplete tail (an open `url(` still waiting for
//!   its close paren, an `@import` string without its close quote, an
//!   unterminated comment or string, or a chunk boundary inside a
//!   `url(`/`@import` prefix) is retained between chunks, so a
//!   chunk-split stylesheet rewrites byte-identically to the one-shot
//!   pass.
//!
//! Issue #36 coverage:
//! - `@import url(...)` and `@import "..."` (string) forms;
//! - `/*...*/` comments in the whitespace around a url() value, and
//!   comments/strings at top level are copied verbatim (a url( or
//!   @import that appears inside comment or string content is never
//!   rewritten - it is text, not a fetch);
//! - quoted url() strings and CSS backslash escapes (literal and hex)
//!   are resolved before rewriting;
//! - `data:`/other opaque URLs and fragment-only references pass
//!   through verbatim, unwrapped;
//! - invalid `url(url(...))` nesting and a comment embedded inside a
//!   url() value are emitted verbatim as a documented fallback rather
//!   than producing a mangled URL.

/// Rewrite every `url(...)` token and `@import "..."` string through
/// `enc`.
pub fn rewrite_stylesheet(css: &str, enc: &dyn Fn(&str) -> String) -> String {
    scan(css, enc, true, None).0
}

/// Incremental url() rewriter for streamed stylesheets.
pub struct CssRewriter {
    /// Retained bytes: from the start of a possibly-incomplete token
    /// (`url(`, `@import`, a comment, a string) to the end of the data
    /// seen so far.
    tail: String,
    /// The byte immediately preceding `tail` in the original stream
    /// (#507): an `image-set(` at the start of a chunk is
    /// boundary-checked against this byte, not against a missing
    /// buffer predecessor.
    prev: Option<u8>,
    enc: Box<dyn Fn(&str) -> String>,
}

impl CssRewriter {
    /// New streaming rewriter; `enc` maps one CSS url to its engine route.
    pub fn new(enc: Box<dyn Fn(&str) -> String>) -> Self {
        Self {
            tail: String::new(),
            prev: None,
            enc,
        }
    }

    /// Feed one body chunk, get back everything that can be emitted now.
    pub fn process(&mut self, chunk: &str) -> String {
        let mut data = std::mem::take(&mut self.tail);
        let prev = self.prev;
        data.push_str(chunk);
        match scan(&data, &self.enc, false, prev) {
            // All input consumed: the next chunk starts after this
            // data last byte. Empty input consumes nothing, so the
            // carried byte stays (#507).
            (out, None) => {
                if let Some(last) = data.as_bytes().last() {
                    self.prev = Some(*last);
                }
                out
            }
            // The retained tail starts at `hold`, preceded by
            // data[hold - 1] in the original stream; a zero hold
            // consumes nothing and keeps the carried byte.
            (out, Some(hold)) => {
                if hold > 0 {
                    self.prev = Some(data.as_bytes()[hold - 1]);
                }
                self.tail = data[hold..].to_string();
                out
            }
        }
    }

    /// End of stream: flush retained bytes. A `url(`/`@import` that
    /// never completed is copied verbatim, exactly like the one-shot
    /// pass over the same complete input.
    pub fn finish(&mut self) -> String {
        let data = std::mem::take(&mut self.tail);
        let prev = self.prev;
        scan(&data, &self.enc, true, prev).0
    }
}

/// What scanning a `url(` token found. `end` is relative to the start
/// of the token (one past the `)`).
enum UrlTok<'a> {
    Complete {
        inner: &'a str,
        end: usize,
    },
    /// `url(` opened but not closed yet (or an escape ran off the end).
    Open,
}

/// What scanning an `@import` found. `end` is relative to the start of
/// the token (one past the closing quote).
enum ImportTok<'a> {
    Str {
        body: &'a str,
        quote: u8,
        end: usize,
    },
    /// `@import` followed by `url(`: leave the URL to the url() pass;
    /// the caller emits the `@import` prefix and continues scanning.
    UrlForm,
    /// `@import` matched but the quoted target is still open.
    Open,
    /// Not an import after all: copy verbatim.
    NotImport,
}

/// Shared scanner. Returns the rewritten output and, when `final_scan`
/// is false, the byte index of a possibly-incomplete token to hold back
/// for the next chunk. With `final_scan` true the input is treated as
/// complete and the hold is always None. `prev` is the byte preceding
/// `data` in the original stream (None only for the one-shot pass,
/// where index 0 is a true boundary): it keeps the identifier check of
/// the image-set branch chunk-independent (#507).
fn scan(
    data: &str,
    enc: &dyn Fn(&str) -> String,
    final_scan: bool,
    prev: Option<u8>,
) -> (String, Option<usize>) {
    let bytes = data.as_bytes();
    let mut out = String::with_capacity(data.len() + 64);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        // #507: at the start of a streamed buffer the previous byte
        // is no longer in `bytes`, so boundary-check against the byte
        // carried from the consumed prefix instead of assuming a
        // token boundary at index 0.
        let ident_boundary = if i > 0 {
            !is_ident_byte(bytes[i - 1])
        } else {
            prev.is_none_or(|p| !is_ident_byte(p))
        };
        if (b == b'i' || b == b'I' || b == b'-') && ident_boundary {
            let rest = &data[i..];
            let mut consumed = None;
            for prefix in ["image-set(", "-webkit-image-set("] {
                if rest.len() < prefix.len()
                    && !final_scan
                    && rest
                        .as_bytes()
                        .eq_ignore_ascii_case(&prefix.as_bytes()[..rest.len()])
                {
                    return (out, Some(i));
                }
                if rest.len() >= prefix.len()
                    && rest.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
                {
                    if let Some(end) = image_set_end(rest, prefix.len()) {
                        push_image_set(&mut out, &rest[..end], prefix.len(), enc);
                        consumed = Some(end);
                        break;
                    }
                    if !final_scan {
                        return (out, Some(i));
                    }
                }
            }
            if let Some(end) = consumed {
                i += end;
                continue;
            }
        }
        if b == b'u' || b == b'U' {
            let rest = &data[i..];
            // Fewer than four bytes left, a case-insensitive prefix of
            // "url(": more data may complete the token, hold it back.
            if !final_scan
                && rest.len() < 4
                && rest.as_bytes().eq_ignore_ascii_case(&b"url("[..rest.len()])
            {
                return (out, Some(i));
            }
            // #178: compare BYTES - slicing &str at a fixed offset
            // panics when a multibyte char straddles the cut.
            if rest.len() >= 4 && rest.as_bytes()[..4].eq_ignore_ascii_case(b"url(") {
                match scan_url(rest) {
                    UrlTok::Complete { inner, end } => {
                        push_url(&mut out, &data[i..i + end], inner, enc);
                        i += end;
                        continue;
                    }
                    UrlTok::Open => {
                        if !final_scan {
                            return (out, Some(i));
                        }
                    }
                }
            }
        } else if b == b'@' {
            let rest = &data[i..];
            if !final_scan
                && rest.len() < 7
                && rest
                    .as_bytes()
                    .eq_ignore_ascii_case(&b"@import"[..rest.len()])
            {
                return (out, Some(i));
            }
            if rest.len() >= 7 && rest.as_bytes()[..7].eq_ignore_ascii_case(b"@import") {
                match scan_import(rest) {
                    ImportTok::Str { body, quote, end } => {
                        push_import(&mut out, body, quote, &rest[..end], enc);
                        i += end;
                        continue;
                    }
                    ImportTok::UrlForm => {
                        out.push_str(&rest[..7]);
                        i += 7;
                        continue;
                    }
                    ImportTok::Open => {
                        if !final_scan {
                            return (out, Some(i));
                        }
                    }
                    ImportTok::NotImport => {}
                }
            }
        } else if b == b'\'' || b == b'"' {
            // Top-level CSS string (selector content, @charset, font
            // families...): copy verbatim, escapes honored, so
            // url(/@import text inside string content is never touched.
            match scan_string(bytes, i) {
                Some(end) => {
                    out.push_str(&data[i..end]);
                    i = end;
                    continue;
                }
                None => {
                    if !final_scan {
                        return (out, Some(i));
                    }
                }
            }
        } else if b == b'/' {
            // A trailing '/' may open a comment the next chunk
            // completes: hold it back.
            if !final_scan && i + 1 >= bytes.len() {
                return (out, Some(i));
            }
            if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                // Top-level comment: copy verbatim (a url( inside a
                // comment is text, not a fetch).
                match data[i + 2..].find("*/") {
                    Some(c) => {
                        let end = i + 2 + c + 2;
                        out.push_str(&data[i..end]);
                        i = end;
                        continue;
                    }
                    None => {
                        if !final_scan {
                            return (out, Some(i));
                        }
                    }
                }
            }
        }
        // Copy one char (UTF-8 safe).
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&data[i..(i + ch_len).min(data.len())]);
        i += ch_len;
    }
    (out, None)
}

/// Scan a `url(...)` token. `s` starts with `url(` (case-insensitive).
fn scan_url(s: &str) -> UrlTok<'_> {
    // Skip whitespace and comments between "url(" and the value.
    let j = match skip_ws_comments(s, 4) {
        Some(j) => j,
        None => return UrlTok::Open, // unterminated comment
    };
    if j >= s.len() {
        return UrlTok::Open;
    }
    let q = s.as_bytes()[j];
    if q == b'\'' || q == b'"' {
        let start = j + 1;
        let k = match scan_string(s.as_bytes(), j) {
            Some(end) => end,
            None => return UrlTok::Open,
        };
        let inner = &s[start..k - 1];
        // ws/comments, then the close paren.
        match skip_ws_comments(s, k) {
            Some(k2) if k2 < s.len() && s.as_bytes()[k2] == b')' => {
                UrlTok::Complete { inner, end: k2 + 1 }
            }
            _ => UrlTok::Open,
        }
    } else {
        // Unquoted: to the first unescaped ')'.
        let start = j;
        let mut k = j;
        loop {
            if k >= s.len() {
                return UrlTok::Open;
            }
            let c = s.as_bytes()[k];
            if c == b'\\' {
                if k + 1 >= s.len() {
                    return UrlTok::Open;
                }
                k += 2;
                continue;
            }
            if c == b')' {
                break;
            }
            k += 1;
        }
        UrlTok::Complete {
            inner: &s[start..k],
            end: k + 1,
        }
    }
}

/// Scan an `@import` prefix. `s` starts with `@import`
/// (case-insensitive).
fn scan_import(s: &str) -> ImportTok<'_> {
    let j = match skip_ws_comments(s, 7) {
        Some(j) => j,
        None => return ImportTok::Open,
    };
    if j >= s.len() {
        return ImportTok::Open; // "@import" with nothing after it yet
    }
    let c = s.as_bytes()[j];
    if c == b'u' || c == b'U' {
        return ImportTok::UrlForm;
    }
    if c == b'\'' || c == b'"' {
        let start = j + 1;
        let k = match scan_string(s.as_bytes(), j) {
            Some(end) => end,
            None => return ImportTok::Open,
        };
        return ImportTok::Str {
            body: &s[start..k - 1],
            quote: c,
            end: k,
        };
    }
    ImportTok::NotImport
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b >= 0x80
}

/// Find the matching close paren, ignoring strings and comments. An
/// incomplete function is held across stream chunks like an open url().
fn image_set_end(s: &str, open_end: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 1;
    let mut j = open_end;
    while j < b.len() {
        if b[j] == b'\'' || b[j] == b'"' {
            j = scan_string(b, j)?;
        } else if j + 1 < b.len() && b[j] == b'/' && b[j + 1] == b'*' {
            j += 2 + s[j + 2..].find("*/")? + 2;
        } else {
            if b[j] == b'(' {
                depth += 1;
            }
            if b[j] == b')' {
                depth -= 1;
                if depth == 0 {
                    return Some(j + 1);
                }
            }
            j += utf8_len(b[j]);
        }
    }
    None
}

/// Bare strings only name URLs at the beginning of a direct image-set
/// candidate. Preserve the quote and all other tokens, including type()
/// strings. url() candidates use the normal URL scanner.
fn push_image_set(out: &mut String, s: &str, open_end: usize, enc: &dyn Fn(&str) -> String) {
    out.push_str(&s[..open_end]);
    let b = s.as_bytes();
    let mut i = open_end;
    let mut depth = 1;
    let mut candidate = true;
    while i < b.len() {
        if b[i] == b'\'' || b[i] == b'"' {
            let end = scan_string(b, i).expect("complete image-set string");
            let original = &s[i..end];
            if candidate && depth == 1 {
                let logical = css_unescape(&s[i + 1..end - 1]);
                if !logical.trim().is_empty()
                    && !logical.starts_with('#')
                    && !is_opaque_scheme(&logical)
                {
                    let quote = b[i] as char;
                    out.push(quote);
                    out.push_str(
                        &enc(&logical)
                            .replace('\\', "\\\\")
                            .replace(quote, &format!("\\{quote}")),
                    );
                    out.push(quote);
                } else {
                    out.push_str(original);
                }
            } else {
                out.push_str(original);
            }
            candidate = false;
            i = end;
            continue;
        }
        if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
            let end = i + 2 + s[i + 2..].find("*/").expect("complete image-set comment") + 2;
            out.push_str(&s[i..end]);
            i = end;
            continue;
        }
        if (b[i] == b'u' || b[i] == b'U')
            && i + 4 <= b.len()
            && b[i..i + 4].eq_ignore_ascii_case(b"url(")
        {
            if let UrlTok::Complete { inner, end } = scan_url(&s[i..]) {
                push_url(out, &s[i..i + end], inner, enc);
                candidate = false;
                i += end;
                continue;
            }
        }
        if b[i] == b'(' {
            depth += 1;
        }
        if b[i] == b')' {
            depth -= 1;
        }
        if b[i] == b',' && depth == 1 {
            candidate = true;
        } else if depth == 1 && !b[i].is_ascii_whitespace() && b[i] != b',' && candidate {
            candidate = false;
        }
        let len = utf8_len(b[i]);
        out.push_str(&s[i..i + len]);
        i += len;
    }
}

/// Index one past the closing quote of the string starting at
/// `from` (the opening quote byte). Escapes: a backslash consumes the
/// next byte (UTF-8 continuation bytes are >= 0x80 and never match an
/// ASCII quote, so byte-level skipping is safe). None when the string
/// is still open.
fn scan_string(bytes: &[u8], from: usize) -> Option<usize> {
    let quote = bytes[from];
    let mut k = from + 1;
    while k < bytes.len() {
        let c = bytes[k];
        if c == b'\\' {
            if k + 1 >= bytes.len() {
                return None;
            }
            k += 2;
            continue;
        }
        if c == quote {
            return Some(k + 1);
        }
        k += 1;
    }
    None
}

/// Advance past ASCII whitespace and `/*...*/` comments starting at
/// `from`. None when a comment is still open (more data may close it).
fn skip_ws_comments(s: &str, from: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut j = from;
    loop {
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j + 1 < b.len() && b[j] == b'/' && b[j + 1] == b'*' {
            let close = s[j + 2..].find("*/")?;
            j += 2 + close + 2;
            continue;
        }
        return Some(j);
    }
}

/// Rewrite one url() value and append it to `out`. `original` is the
/// complete token slice (used verbatim for every pass-through shape);
/// `inner` is the raw value between the parens/quotes.
fn push_url(out: &mut String, original: &str, inner: &str, enc: &dyn Fn(&str) -> String) {
    let trimmed = trim_url_edges(inner);
    // Documented fallbacks, emitted verbatim: empty url(), a comment
    // embedded in the middle of the value, and url(url(...)) nesting
    // (never valid CSS - rewriting it would emit a mangled URL).
    if trimmed.is_empty() || trimmed.contains("/*") || trimmed.to_ascii_lowercase().contains("url(")
    {
        out.push_str(original);
        return;
    }
    // Fragment-only and opaque (data:, blob:, about:, ...) references
    // never reach the network through the engine: keep the original
    // spelling so the DOM sees exactly what the source said.
    if trimmed.starts_with('#') || is_opaque_scheme(trimmed) {
        out.push_str(original);
        return;
    }
    let logical = css_unescape(trimmed);
    let rewritten = enc(&logical);
    out.push_str("url('");
    out.push_str(&rewritten.replace('\\', "\\\\").replace('\'', "\\'"));
    out.push_str("')");
}

/// Append a rewritten `@import "..."`. `original` is the complete
/// `@import "..."` slice for the pass-through shapes.
fn push_import(
    out: &mut String,
    body: &str,
    quote: u8,
    original: &str,
    enc: &dyn Fn(&str) -> String,
) {
    let logical = css_unescape(body);
    if logical.trim().is_empty() || is_opaque_scheme(logical.trim()) {
        out.push_str(original);
        return;
    }
    let rewritten = enc(logical.trim());
    out.push_str("@import ");
    out.push(quote as char);
    if quote == b'"' {
        out.push_str(&rewritten.replace('\\', "\\\\").replace('"', "\\\""));
    } else {
        out.push_str(&rewritten.replace('\\', "\\\\").replace('\'', "\\'"));
    }
    out.push(quote as char);
}

/// Trim ASCII whitespace and comments at the EDGES of a url() value.
/// A comment left in the middle makes the value a verbatim fallback
/// (detected by the caller).
fn trim_url_edges(s: &str) -> &str {
    let mut t = s.trim();
    loop {
        let before = t;
        if let Some(u) = t.strip_prefix("/*") {
            if let Some(e) = u.find("*/") {
                t = u[e + 2..].trim_start();
            }
        }
        if let Some(p) = t.strip_suffix("*/") {
            if let Some(st) = p.rfind("/*") {
                t = p[..st].trim_end();
            }
        }
        if t.len() == before.len() {
            return t;
        }
    }
}

/// True for an absolute URL with a scheme the engine cannot route
/// (anything but http/https, e.g. data:, blob:, about:).
fn is_opaque_scheme(u: &str) -> bool {
    if let Some(ci) = u.find(':') {
        let sch = &u[..ci];
        if crate::encode::is_scheme(sch) {
            return !sch.eq_ignore_ascii_case("http") && !sch.eq_ignore_ascii_case("https");
        }
    }
    false
}

/// Resolve CSS backslash escapes to the logical string: `\X` -> X and
/// `\XXXXXX ` -> the code point (1-6 hex digits, one following
/// whitespace char consumed, per CSS). Invalid code points (including
/// 0) become U+FFFD; a lone trailing backslash is dropped.
fn css_unescape(s: &str) -> String {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut out = String::with_capacity(s.len());
    let mut k = 0;
    while k < chars.len() {
        let (_, ch) = chars[k];
        if ch != '\\' {
            out.push(ch);
            k += 1;
            continue;
        }
        let mut j = k + 1;
        let mut hex = String::new();
        while j < chars.len() && hex.len() < 6 && chars[j].1.is_ascii_hexdigit() {
            hex.push(chars[j].1);
            j += 1;
        }
        if hex.is_empty() {
            if j < chars.len() {
                out.push(chars[j].1);
                k = j + 1;
            } else {
                k = j; // lone trailing backslash: dropped
            }
        } else {
            let cp = u32::from_str_radix(&hex, 16).unwrap_or(0xfffd);
            let c = if cp == 0 {
                '\u{fffd}'
            } else {
                char::from_u32(cp).unwrap_or('\u{fffd}')
            };
            out.push(c);
            // One whitespace char right after the hex digits belongs
            // to the escape.
            if j < chars.len() && chars[j].1.is_ascii_whitespace() {
                j += 1;
            }
            k = j;
        }
    }
    out
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

    fn enc(u: &str) -> String {
        format!("[{}]", u)
    }

    /// Feed `css` through CssRewriter split at every char boundary in
    /// `splits`, compare against the one-shot pass over the same input.
    /// (Real chunks always end on char boundaries: TextDecoder with
    /// stream:true never splits a code point.)
    fn chunked_eq(css: &str, splits: &[usize]) {
        for &s in splits {
            let (a, b) = css.split_at(s);
            let mut r = CssRewriter::new(Box::new(enc));
            let mut out = r.process(a);
            out.push_str(&r.process(b));
            out.push_str(&r.finish());
            assert_eq!(out, rewrite_stylesheet(css, &enc), "split at {}", s);
        }
    }

    fn all_splits(css: &str) -> Vec<usize> {
        css.char_indices()
            .map(|(i, _)| i)
            .filter(|&i| i > 0)
            .collect()
    }

    /// #507: an `image-set(` that is the tail of a longer identifier
    /// (`pngimage-set(` here) is not a rewrite candidate, and a chunk
    /// boundary landing exactly before the token must not turn it
    /// into one: the streaming pass boundary-checks against the
    /// carried byte, not the missing buffer predecessor.
    #[test]
    fn image_set_identifier_tail_is_chunk_invariant() {
        let css = r#"}}//h.example/px.pngimage-set("a.png" 1x, 'b' 2x)"#;
        assert_eq!(rewrite_stylesheet(css, &enc), css);
        chunked_eq(css, &all_splits(css));
        // A real boundary still rewrites, including when the split
        // lands directly before the token.
        let real = r#";image-set("a.png" 1x)"#;
        assert_eq!(
            rewrite_stylesheet(real, &enc),
            r#";image-set("[a.png]" 1x)"#
        );
        chunked_eq(real, &all_splits(real));
    }

    #[test]
    fn urls() {
        let out = rewrite_stylesheet(
            "a{background:url(img/x.png)}b{background:url( 'y.png' )}",
            &enc,
        );
        assert_eq!(
            out,
            "a{background:url('[img/x.png]')}b{background:url('[y.png]')}"
        );
    }

    #[test]
    fn image_set_bare_string_candidates() {
        let css = "a{background:image-set(\"a.png\" 1x, 'b.png' 2x, url(c.png) 3x)}";
        let expected = "a{background:image-set(\"[a.png]\" 1x, '[b.png]' 2x, url('[c.png]') 3x)}";
        assert_eq!(rewrite_stylesheet(css, &enc), expected);
        chunked_eq(css, &all_splits(css));
        let prefixed = "a{background:-webkit-image-set(\"a.png\" 1x)}";
        assert_eq!(
            rewrite_stylesheet(prefixed, &enc),
            "a{background:-webkit-image-set(\"[a.png]\" 1x)}"
        );
        chunked_eq(prefixed, &all_splits(prefixed));
    }

    #[test]
    fn image_set_keeps_non_candidate_strings_and_opaque_urls() {
        let css = "a{content:\"image-set('x')\";background:image-set('data:image/png,x' 1x type('image/png'), url(#icon) 2x)}/* image-set('x') */";
        assert_eq!(rewrite_stylesheet(css, &enc), css);
        chunked_eq(css, &all_splits(css));
    }

    #[test]
    fn passthrough_no_url() {
        let out = rewrite_stylesheet("a{color:red}", &enc);
        assert_eq!(out, "a{color:red}");
    }

    #[test]
    fn quoted_urls_and_escapes() {
        let out = rewrite_stylesheet(
            "a{background:url(\"x y.png\")}b{list-style:url('\\\"bullet\\\".png')}",
            &enc,
        );
        assert_eq!(
            out,
            "a{background:url('[x y.png]')}b{list-style:url('[\"bullet\".png]')}"
        );
        // An escaped close paren stays inside the URL.
        let out = rewrite_stylesheet("a{background:url(a\\)b.png)}", &enc);
        assert_eq!(out, "a{background:url('[a)b.png]')}");
        // Hex escapes resolve to the logical URL.
        let out = rewrite_stylesheet("a{background:url(\\6F ne.png)}", &enc);
        assert_eq!(out, "a{background:url('[one.png]')}");
    }

    #[test]
    fn import_string_and_url_forms() {
        let out = rewrite_stylesheet("@import \"x.css\";b{}", &enc);
        assert_eq!(out, "@import \"[x.css]\";b{}");
        let out = rewrite_stylesheet("@import 'y.css' screen;", &enc);
        assert_eq!(out, "@import '[y.css]' screen;");
        let out = rewrite_stylesheet("@import url(z.css) print;", &enc);
        assert_eq!(out, "@import url('[z.css]') print;");
        // Escape inside an import string. The re-emitted string keeps
        // the escaped quote: a raw \" inside a CSS string token would
        // terminate it early, so the escape is preserved exactly like
        // the url() string pass does.
        let out = rewrite_stylesheet("@import \"a\\\"b.css\";", &enc);
        assert_eq!(out, "@import \"[a\\\"b.css]\";");
    }

    #[test]
    fn comments_around_url_tokens() {
        // Comments in the whitespace inside url() are fine.
        let out = rewrite_stylesheet("a{background:url( /*c*/ x.png /*c*/ )}", &enc);
        assert_eq!(out, "a{background:url('[x.png]')}");
        // A comment embedded in the middle of the value is a verbatim
        // fallback (documented).
        let css = "a{background:url(x /*c*/ y.png)}";
        assert_eq!(rewrite_stylesheet(css, &enc), css);
        // url( inside a comment or a string is text, not a fetch.
        let css = "/* url(noop.png) */a{content:\"url(noop.png)\"}";
        assert_eq!(rewrite_stylesheet(css, &enc), css);
    }

    #[test]
    fn opaque_and_fragment_urls_verbatim() {
        let css = "a{background:url(data:image/png;base64,AAA)}b{fill:url(#g)}c{src:url(blob:x)}";
        assert_eq!(rewrite_stylesheet(css, &enc), css);
        let out = rewrite_stylesheet("@import \"data:text/css,x\"", &enc);
        assert_eq!(out, "@import \"data:text/css,x\"");
    }

    #[test]
    fn nested_url_verbatim() {
        let css = "a{background:url(url(x.png))}";
        assert_eq!(rewrite_stylesheet(css, &enc), css);
    }

    #[test]
    fn streaming_matches_one_shot() {
        let css = "a{background:url(https://e.com/x.png)}b{background:url( 'y.png' )}\u{e5}rste{c:url(\"z.woff2\")}@media print{body{color:red}}";
        chunked_eq(css, &all_splits(css));
    }

    #[test]
    fn streaming_matches_one_shot_new_constructs() {
        // Every issue #36 construct, split at every char boundary.
        let css = "@import \"i.css\";a{background:url(x /*c*/ y.png)}b{b:url(\"q.png\");c:url(data:image/png;base64,AA,A)}d{e:url(a\\)b.png)}/*url(c.png)*/f{g:url(#h)}@import 'j.css' screen;";
        chunked_eq(css, &all_splits(css));
    }

    #[test]
    fn streaming_holds_open_url_across_chunks() {
        // The url( token opens in chunk 1, its close paren arrives in
        // chunk 3: the rewrite must still happen.
        let mut r = CssRewriter::new(Box::new(enc));
        assert_eq!(r.process("a{background:url("), "a{background:");
        assert_eq!(r.process("im"), "");
        assert_eq!(r.process("g/x.png)}"), "url('[img/x.png]')}");
        assert_eq!(r.finish(), "");
    }

    #[test]
    fn streaming_holds_partial_prefix() {
        // Chunk 1 ends inside the "url(" prefix itself.
        let mut r = CssRewriter::new(Box::new(enc));
        assert_eq!(r.process("a{background:ur"), "a{background:");
        assert_eq!(r.process("l(x.png)}"), "url('[x.png]')}");
        assert_eq!(r.finish(), "");
    }

    #[test]
    fn streaming_holds_open_import_string() {
        let mut r = CssRewriter::new(Box::new(enc));
        assert_eq!(r.process("a{@import \"x"), "a{");
        assert_eq!(r.process(".css\";}"), "@import \"[x.css]\";}");
        assert_eq!(r.finish(), "");
    }

    #[test]
    fn streaming_holds_open_comment_and_string() {
        // A top-level string that swallows a comment look-alike, and a
        // comment boundary held across chunks: neither may let the
        // url( inside them be rewritten as a fetch.
        let mut r = CssRewriter::new(Box::new(enc));
        assert_eq!(r.process("a{content:\"/*"), "a{content:");
        assert_eq!(
            r.process("x*/\";b:url(y.png)}"),
            "\"/*x*/\";b:url('[y.png]')}"
        );
        assert_eq!(r.finish(), "");
    }

    #[test]
    fn streaming_unclosed_url_verbatim() {
        let css = "a{background:url(https://e.com/x.png";
        let mut r = CssRewriter::new(Box::new(enc));
        let mut out = r.process(css);
        out.push_str(&r.finish());
        assert_eq!(out, css);
        // One-shot parity: the same complete input passes through too.
        assert_eq!(rewrite_stylesheet(css, &enc), css);
    }

    #[test]
    fn multibyte_after_token_start_does_not_panic() {
        // #178: the url(/@import prefix checks sliced &str at fixed
        // byte offsets; a multibyte character straddling the cut
        // panicked the wasm call. They must compare bytes.
        let css = "a{u\u{1f600}rl(}b{@impo\u{1f600}rt}";
        assert_eq!(rewrite_stylesheet(css, &enc), css);
        let mut r = CssRewriter::new(Box::new(enc));
        let mut out = r.process(css);
        out.push_str(&r.finish());
        assert_eq!(out, css);
    }
}
