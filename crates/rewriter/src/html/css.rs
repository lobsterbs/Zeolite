//! Streaming CSS url() rewriting for <style> blocks, inline style
//! attributes and standalone stylesheets. One scan, two faces:
//! - `rewrite_stylesheet`: one-shot over a complete string (style
//!   blocks are raw-text within the HTML stream anyway);
//! - `CssRewriter`: incremental, for streamed stylesheet bodies. Only
//!   the potentially incomplete tail (an open `url(` still waiting for
//!   its close paren, or a chunk boundary inside a `url(` prefix) is
//!   retained between chunks, so a chunk-split stylesheet rewrites
//!   byte-identically to the one-shot pass.

/// Rewrite every `url(...)` token through `enc`.
///
/// Honest scope: only `url(...)` forms are rewritten. `@import "..."`
/// string forms are NOT handled (a doc comment here claimed they were;
/// it never was true - import strings pass through untouched).
pub fn rewrite_stylesheet(css: &str, enc: &dyn Fn(&str) -> String) -> String {
    scan(css, enc, true).0
}

/// Incremental url() rewriter for streamed stylesheets.
pub struct CssRewriter {
    /// Retained bytes: from the start of a possibly-incomplete `url(`
    /// token to the end of the data seen so far.
    tail: String,
    enc: Box<dyn Fn(&str) -> String>,
}

impl CssRewriter {
    /// New streaming rewriter; `enc` maps one CSS url to its engine route.
    pub fn new(enc: Box<dyn Fn(&str) -> String>) -> Self {
        Self {
            tail: String::new(),
            enc,
        }
    }

    /// Feed one body chunk, get back everything that can be emitted now.
    pub fn process(&mut self, chunk: &str) -> String {
        let mut data = std::mem::take(&mut self.tail);
        data.push_str(chunk);
        match scan(&data, &self.enc, false) {
            (out, None) => out,
            (out, Some(hold)) => {
                self.tail = data[hold..].to_string();
                out
            }
        }
    }

    /// End of stream: flush retained bytes. An `url(` that never closed
    /// is copied verbatim, exactly like the one-shot pass over the same
    /// complete input.
    pub fn finish(&mut self) -> String {
        let data = std::mem::take(&mut self.tail);
        scan(&data, &self.enc, true).0
    }
}

/// Shared scanner. Returns the rewritten output and, when `final_scan`
/// is false, the byte index of a possibly-incomplete `url(` tail to
/// hold back for the next chunk. With `final_scan` true the input is
/// treated as complete and the hold is always None.
fn scan(data: &str, enc: &dyn Fn(&str) -> String, final_scan: bool) -> (String, Option<usize>) {
    let bytes = data.as_bytes();
    let mut out = String::with_capacity(data.len() + 64);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'u' || bytes[i] == b'U' {
            let rest = &data[i..];
            if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("url(") {
                let paren = i + 4;
                // Find matching close paren.
                if let Some(close) = data[paren..].find(')') {
                    let inner = data[paren..paren + close].trim();
                    let url = inner.trim_matches(|c| c == '\'' || c == '"');
                    out.push_str("url('");
                    out.push_str(&enc(url));
                    out.push_str("')");
                    i = paren + close + 1;
                    continue;
                }
                // Open `url(` with no close paren yet: hold back for
                // more data, or copy verbatim at end of stream.
                if !final_scan {
                    return (out, Some(i));
                }
            } else if !final_scan && is_partial_url_prefix(rest) {
                // Fewer than four bytes left and they case-insensitively
                // prefix "url(": more data may complete the token.
                return (out, Some(i));
            }
        }
        // Copy one char (UTF-8 safe).
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&data[i..(i + ch_len).min(data.len())]);
        i += ch_len;
    }
    (out, None)
}

/// `rest` is shorter than "url(" and is a case-insensitive prefix of it.
fn is_partial_url_prefix(rest: &str) -> bool {
    let needle = b"url(";
    rest.len() < 4 && rest.as_bytes().eq_ignore_ascii_case(&needle[..rest.len()])
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

    #[test]
    fn urls() {
        let out = rewrite_stylesheet(
            "a{background:url(img/x.png)}b{background:url( 'y.png' )}",
            &enc,
        );
        assert_eq!(out, "a{background:url('[img/x.png]')}b{background:url('[y.png]')}");
    }

    #[test]
    fn passthrough_no_url() {
        let out = rewrite_stylesheet("a{color:red}", &enc);
        assert_eq!(out, "a{color:red}");
    }

    #[test]
    fn streaming_matches_one_shot() {
        let css = "a{background:url(https://e.com/x.png)}b{background:url( 'y.png' )}\u{e5}rste{c:url(\"z.woff2\")}@media print{body{color:red}}";
        let splits: Vec<usize> = css
            .char_indices()
            .map(|(i, _)| i)
            .filter(|&i| i > 0)
            .collect();
        chunked_eq(css, &splits);
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
    fn streaming_unclosed_url_verbatim() {
        let css = "a{background:url(https://e.com/x.png";
        let mut r = CssRewriter::new(Box::new(enc));
        let mut out = r.process(css);
        out.push_str(&r.finish());
        assert_eq!(out, css);
        // One-shot parity: the same complete input passes through too.
        assert_eq!(rewrite_stylesheet(css, &enc), css);
    }
}
