//! Streaming HTML rewriter.
//!
//! Incremental, rewrite-in-emit tokenizer. `process(chunk)` consumes as
//! much as it can and returns rewritten output; incomplete tokens (a tag
//! cut mid-attribute, a <script> without its close tag yet, a comment
//! without its terminator) are retained in `buf` until more input or
//! `finish()` arrives.
//!
//! Text is emitted immediately: a chunk with no '<' is pure text and
//! flushes in full. Only an open '<' (or an in-progress raw block) is
//! ever retained across chunk boundaries.
//!
//! Phase 3: ad/tracker blocking (tags whose resolved URL host matches
//! cfg.block_hosts are dropped entirely, so the request never fires)
//! and injection hooks (per-site extra <script>s emitted right after
//! the bootstrap).

pub mod css;
pub mod url_attrs;

use crate::config::RewriteConfig;
use crate::encode::resolve;

/// Tokenizer state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Text,
    /// Inside <tag ...>, until the closing '>'.
    Tag,
    /// Inside <script>/<style> raw text until the matching close tag.
    /// The whole raw block is held until its close tag arrives: the JS
    /// and CSS passes are single-shot over a complete block, and a
    /// split literal would rewrite incorrectly. Scripts execute only
    /// after their block closes, so this does not delay first paint.
    Raw,
    Comment,
    Doctype,
}

/// Tags whose entire element is dropped when its URL attribute points
/// at a blocked host.
const BLOCKABLE: &[&str] = &[
    "script", "img", "iframe", "link", "source", "video", "audio", "embed", "track", "object",
];

pub struct Rewriter {
    cfg: RewriteConfig,
    /// Real destination URL of the page being rewritten (page base).
    base: String,
    st: St,
    buf: String,
    /// Lowercase name of the current tag while in Tag/Raw state.
    cur_tag: String,
    /// The element being entered was dropped (blocked host): its raw
    /// content and close tag must be swallowed, not emitted.
    drop_raw: bool,
    injected: bool,
}

impl Rewriter {
    pub fn new(cfg: RewriteConfig) -> Self {
        Self {
            cfg,
            base: String::new(),
            st: St::Text,
            buf: String::new(),
            cur_tag: String::new(),
            drop_raw: false,
            injected: false,
        }
    }

    /// Set the page's real destination URL (call before the first chunk).
    pub fn set_base(&mut self, base: &str) {
        self.base = base.to_string();
    }

    /// Replace the block_hosts list (Phase 3 ad/tracker stripping).
    pub fn set_blocked_hosts(&mut self, hosts: Vec<String>) {
        self.cfg.block_hosts = hosts;
    }

    /// Add a script path to inject after <head> opens (Phase 3 hooks).
    pub fn add_injection(&mut self, path: &str) {
        self.cfg.injections.push(path.to_string());
    }

    fn enc(&self, url: &str) -> String {
        // Already engine-local (nested rewriting): keep as-is. An empty
        // origin matches every URL, so it must not take this branch.
        if !self.cfg.origin.is_empty() && url.starts_with(&self.cfg.origin) {
            return url.to_string();
        }
        // Already-encoded engine route (root-relative, engine-origin-
        // absolute, or target-host-bound): never let resolve() bind a
        // route to the target host and never add another wrap layer
        // (the double-wrap loop, issue #1 finding 4). Unwrap ALL layers
        // and re-emit ONE proper engine route for the innermost
        // destination. Only a decodable http(s) destination counts, so a
        // target page genuinely using the prefix as a plain path still
        // rewrites normally.
        if let Some(innermost) = self.cfg.unwrap_engine_route(url) {
            if innermost.starts_with("http://") || innermost.starts_with("https://") {
                let (bare, frag) = match innermost.split_once('#') {
                    Some((b, f)) => (b.to_string(), format!("#{}", f)),
                    None => (innermost, String::new()),
                };
                let mut out = self.cfg.encode_url(&bare);
                out.push_str(&frag);
                return out;
            }
        }
        let abs = resolve(url, &self.base);
        // Fragment-only and empty URLs never reach the network: the
        // browser resolves them against the CURRENT route. Encoding
        // them would manufacture a bare engine-prefix route with no
        // destination at all (issue #12: every same-page anchor link
        // navigated to 404 "zeolite: bad route").
        if abs.is_empty() || abs.starts_with('#') {
            return abs;
        }
        // Fragments are client-side only (SVG sprite symbol selection,
        // in-page anchors). They must never become part of the encoded
        // request target: every "#symbol" variant of one sprite is the
        // same network resource. The fragment is re-attached after the
        // engine route so the browser keeps its fragment semantics.
        let (bare, frag) = match abs.split_once('#') {
            Some((b, f)) => (b.to_string(), format!("#{}", f)),
            None => (abs, String::new()),
        };
        let mut out = self.cfg.encode_url(&bare);
        out.push_str(&frag);
        out
    }

    /// Emit bootstrap + injections. Called once, right after <head>
    /// (fallback <html>, final fallback at finish()).
    fn emit_injections(&mut self) -> String {
        if self.injected {
            return String::new();
        }
        self.injected = true;
        let mut out = String::new();
        if self.cfg.inject_bootstrap {
            out.push_str(&format!(
                "<script src=\"{}\"></script>",
                self.cfg.bootstrap_path
            ));
        }
        for path in &self.cfg.injections {
            out.push_str(&format!("<script src=\"{}\"></script>", path));
        }
        out
    }

    pub fn process(&mut self, chunk: &str) -> String {
        self.buf.push_str(chunk);
        let mut out = String::with_capacity(self.buf.len());
        loop {
            match self.st {
                St::Text => {
                    match self.buf.find('<') {
                        None => {
                            // Pure text: emit everything now (streaming).
                            out.push_str(&self.buf);
                            self.buf.clear();
                            break;
                        }
                        Some(lt) => {
                            out.push_str(&self.buf[..lt]);
                            self.buf.drain(..lt);
                            match classify_open(&self.buf) {
                                Some((st, name)) => {
                                    self.st = st;
                                    if st == St::Tag {
                                        self.cur_tag = name;
                                    }
                                }
                                None => {
                                    if self.buf.len() < 10 {
                                        break; // '<' near the end: wait for more input
                                    }
                                    // A literal '<' that starts no markup (rare).
                                    out.push('<');
                                    self.buf.remove(0);
                                }
                            }
                        }
                    }
                }
                St::Comment => {
                    if !eat_marker(&mut self.buf, &mut out, "-->") {
                        break;
                    }
                    self.st = St::Text;
                }
                St::Doctype => {
                    if !eat_marker(&mut self.buf, &mut out, ">") {
                        break;
                    }
                    self.st = St::Text;
                }
                St::Tag => {
                    // Need the full tag before rewriting attributes.
                    match self.try_rewrite_tag(&self.buf) {
                        Some((end, rewritten)) => {
                            out.push_str(&rewritten);
                            self.buf.drain(..end);
                            let raw = is_raw_tag(&self.cur_tag);
                            // Inject bootstrap + per-site hooks right after
                            // the opening <head> (fallback: <html>) so they
                            // precede all page scripts.
                            if self.cur_tag == "head" || self.cur_tag == "html" {
                                out.push_str(&self.emit_injections());
                            }
                            if raw {
                                // Raw state needs cur_tag to locate the
                                // close tag and pick the rewrite pass.
                                self.st = St::Raw;
                                self.drop_raw = rewritten.is_empty();
                            } else {
                                self.st = St::Text;
                                self.cur_tag.clear();
                            }
                        }
                        None => break, // incomplete tag: wait for more input
                    }
                }
                St::Raw => {
                    let close = format!("</{}", self.cur_tag);
                    let Some(ci) = find_ci(&self.buf, &close) else {
                        break;
                    };
                    // The close tag's '>' (or a partial close: keep it).
                    let after = self.buf[ci..].find('>').map(|i| ci + i + 1);
                    let Some(end) = after else {
                        break;
                    };
                    if self.drop_raw {
                        // Blocked element: swallow content + close tag.
                        self.buf.drain(..end);
                    } else {
                        let raw = self.buf[..ci].to_string();
                        if self.cur_tag == "style" && self.cfg.rewrite_css {
                            out.push_str(&css::rewrite_stylesheet(&raw, &|u| self.enc(u)));
                        } else if self.cur_tag == "script" && self.cfg.rewrite_js_literals {
                            // Frame-buster neutralization runs AFTER the
                            // URL-literal pass (same order as the server
                            // engine's pipeline) so folded guards and
                            // navigation sinks apply to the final body.
                            let rewritten = crate::js::rewrite_script(&raw, &|u| self.enc(u));
                            out.push_str(&crate::js::antiframe(&rewritten));
                        } else {
                            out.push_str(&raw);
                        }
                        // Emit the close tag verbatim, return to Text.
                        out.push_str(&self.buf[ci..end]);
                        self.buf.drain(..end);
                    }
                    self.st = St::Text;
                    self.drop_raw = false;
                    self.cur_tag.clear();
                }
            }
        }
        out
    }

    /// Flush: emit retained buffer as-is (end of stream).
    pub fn finish(&mut self) -> String {
        let mut out = std::mem::take(&mut self.buf);
        out.push_str(&self.emit_injections());
        self.st = St::Text;
        out
    }

    /// Try to fully parse + rewrite the tag at the start of buf.
    /// Returns (bytes consumed, rewritten tag) if the tag is complete.
    fn try_rewrite_tag(&self, buf: &str) -> Option<(usize, String)> {
        // Find the '>' that closes the tag, respecting quoted attr values.
        let bytes = buf.as_bytes();
        let mut i = 1; // past '<'
        if i < bytes.len() && bytes[i] == b'/' {
            i += 1;
        }
        let mut quote: Option<u8> = None;
        while i < bytes.len() {
            let b = bytes[i];
            match quote {
                Some(q) => {
                    if b == q {
                        quote = None;
                    }
                }
                None => {
                    if b == b'"' || b == b'\'' {
                        quote = Some(b);
                    } else if b == b'>' {
                        break;
                    }
                }
            }
            i += 1;
        }
        if i >= bytes.len() {
            return None; // no closing '>' yet
        }
        let end = i + 1; // include '>'
        let rewritten = self.rewrite_single_tag(&buf[..end]);
        Some((end, rewritten))
    }

    /// Rewrite one complete, well-formed tag string. Returns an empty
    /// string when the tag is dropped (blocked host).
    fn rewrite_single_tag(&self, raw: &str) -> String {
        let name_end = raw[1..]
            .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
            .map(|i| i + 1)
            .unwrap_or(raw.len());
        let name = raw[1..name_end].to_ascii_lowercase();
        let mut out = String::with_capacity(raw.len() + 64);
        out.push('<');
        out.push_str(&raw[1..name_end]);
        let mut rest = &raw[name_end..];
        let mut first_url: Option<String> = None;
        while let Some(attr) = next_attr(rest) {
            let Attr {
                consumed,
                lead_ws,
                name: attr_name,
                value: attr_value,
                quote,
            } = attr;
            let lower = attr_name.to_ascii_lowercase();
            match attr_value {
                Some(v) => {
                    // Attribute values reach the DOM entity-decoded; the
                    // tokenizer hands over raw source text. Decode before
                    // any resolve or encode pass (issue #24: a stylesheet
                    // href's "&amp;" reached the upstream request line
                    // verbatim and load.php saw "amp;modules" params);
                    // format_attr re-escapes on emit.
                    let v = decode_entities(&v);
                    if url_attrs::is_url_attr(&name, &lower) && first_url.is_none() {
                        // Remember the first URL for the block decision.
                        first_url = Some(resolve(&v, &self.base));
                    }
                    let newv = if lower == "srcset" || lower == "imagesrcset" {
                        Some(url_attrs::rewrite_srcset(&v, &|u| self.enc(u)))
                    } else if lower == "style" && self.cfg.rewrite_css {
                        Some(css::rewrite_stylesheet(&v, &|u| self.enc(u)))
                    } else if url_attrs::is_url_attr(&name, &lower) {
                        Some(self.enc(&v))
                    } else if is_event_attr(&lower) && self.cfg.rewrite_js_literals {
                        Some(crate::js::antiframe(&crate::js::rewrite_inline(&v, &|u| {
                            self.enc(u)
                        })))
                    } else {
                        None
                    };
                    // Whitespace between attributes must survive the
                    // rewrite or tags come out as `<imgsrc=...`.
                    out.push_str(&lead_ws);
                    out.push_str(&format_attr(
                        &attr_name,
                        newv.as_deref().unwrap_or(&v),
                        quote,
                    ));
                }
                None => {
                    out.push_str(&lead_ws);
                    out.push_str(attr_name.trim_end());
                }
            }
            rest = &rest[consumed..];
        }
        // Block decision: only whole-resource tags with a blocked URL
        // host are dropped. Rewriting already happened above; dropping
        // the final output is still cheaper than a request.
        if BLOCKABLE.contains(&name.as_str()) {
            if let Some(url) = &first_url {
                if self.cfg.is_blocked(url) {
                    return String::new();
                }
            }
        }
        out.push_str(rest);
        out
    }
}

/// Classify what follows a '<'. Returns (state, tag name).
fn classify_open(buf: &str) -> Option<(St, String)> {
    let b = buf.as_bytes();
    if b.len() < 2 {
        return None;
    }
    if b[1] == b'!' {
        if buf.starts_with("<!--") {
            return Some((St::Comment, String::new()));
        }
        return Some((St::Doctype, String::new()));
    }
    if b[1] == b'/' {
        return Some((St::Tag, String::new())); // close tags pass through Tag state
    }
    if b[1].is_ascii_alphabetic() {
        let name: String = buf[1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        return Some((St::Tag, name));
    }
    None
}

fn is_raw_tag(tag: &str) -> bool {
    matches!(tag, "script" | "style")
}

fn is_event_attr(attr: &str) -> bool {
    attr.starts_with("on") && attr.len() > 2
}

/// Case-insensitive find, ASCII only.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// If buf contains marker: emit up to and including it, return true.
/// Otherwise emit everything except a tail that could still become the
/// marker, return false.
fn eat_marker(buf: &mut String, out: &mut String, marker: &str) -> bool {
    if let Some(i) = buf.find(marker) {
        out.push_str(&buf[..i + marker.len()]);
        buf.drain(..i + marker.len());
        true
    } else {
        let keep = marker.len().saturating_sub(1);
        let cut = buf.len().saturating_sub(keep);
        out.push_str(&buf[..cut]);
        buf.drain(..cut);
        false
    }
}

/// One parsed attribute: the bytes it consumed, the whitespace that
/// preceded it (preserved on emit), its name, its optional value, and
/// the quote character when the value was quoted.
struct Attr {
    consumed: usize,
    lead_ws: String,
    name: String,
    value: Option<String>,
    quote: Option<char>,
}

/// Pull one attribute (name, optional =value) off the front of s.
/// Returns None when the remaining text is not an attribute (tag end).
fn next_attr(s: &str) -> Option<Attr> {
    let trimmed = s.trim_start();
    let lead_ws = s[..s.len() - trimmed.len()].to_string();
    if trimmed.is_empty() || trimmed.starts_with('>') || trimmed.starts_with("/>") {
        return None;
    }
    // Name runs to '=', whitespace, or '>'.
    let name_end = trimmed
        .find(|c: char| c == '=' || c.is_ascii_whitespace() || c == '>')
        .unwrap_or(trimmed.len());
    let name = trimmed[..name_end].to_string();
    let rest = &trimmed[name_end..];
    let after_ws = rest.trim_start();
    if after_ws.starts_with('=') {
        let eq = name_end + (rest.len() - after_ws.len()) + 1;
        let vrest = &trimmed[eq..];
        let vstart = vrest.trim_start();
        let ws = vrest.len() - vstart.len();
        let (val, consumed_v, quote) = if vstart.starts_with('"') || vstart.starts_with('\'') {
            let q = vstart.as_bytes()[0] as char;
            // Value not closed yet.
            let i = vstart[1..].find(q)?;
            (vstart[1..1 + i].to_string(), ws + 1 + i + 1, Some(q))
        } else {
            let end = vstart
                .find(|c: char| c.is_ascii_whitespace() || c == '>')
                .unwrap_or(vstart.len());
            (vstart[..end].to_string(), ws + end, None)
        };
        let consumed = lead_ws.len() + eq + consumed_v;
        return Some(Attr {
            consumed,
            lead_ws,
            name,
            value: Some(val),
            quote,
        });
    }
    // Boolean attribute (no value).
    let consumed = lead_ws.len() + name_end;
    Some(Attr {
        consumed,
        lead_ws,
        name,
        value: None,
        quote: None,
    })
}

/// Entities the HTML serializer emits in attribute values, plus the
/// two apostrophe spellings. Anything else is left for the browser.
const NAMED_ENTITIES: &[(&str, char)] = &[
    ("&amp;", '&'),
    ("&lt;", '<'),
    ("&gt;", '>'),
    ("&quot;", '"'),
    ("&#39;", '\''),
    ("&apos;", '\''),
];

/// Decode one numeric character reference at the start of s
/// ("&#38;" / "&#x26;"): the character and the bytes it consumed.
fn decode_numeric(s: &str) -> Option<(char, usize)> {
    let b = s.as_bytes();
    if b.len() < 4 || b[0] != b'&' || b[1] != b'#' {
        return None;
    }
    let (radix, start) = if b[2] == b'x' || b[2] == b'X' {
        (16, 3)
    } else {
        (10, 2)
    };
    let hex = radix == 16;
    let mut end = start;
    while end < b.len() && (b[end].is_ascii_digit() || (hex && b[end].is_ascii_hexdigit())) {
        end += 1;
    }
    if end == start || end >= b.len() || b[end] != b';' {
        return None;
    }
    let cp = u32::from_str_radix(&s[start..end], radix).ok()?;
    Some((char::from_u32(cp)?, end + 1))
}

/// Decode the entities an attribute value may carry so resolve and
/// encode see the text the browser's HTML parser hands the DOM;
/// format_attr re-escapes the decoded value on emit, so the round
/// trip is stable. Issue #24: a stylesheet href's "&amp;" separators
/// reached the upstream request line verbatim, load.php saw params
/// named "amp;modules" and answered its error page instead of CSS.
fn decode_entities(s: &str) -> String {
    let Some(first) = s.find('&') else {
        return s.to_string();
    };
    let mut out = String::with_capacity(s.len());
    out.push_str(&s[..first]);
    let mut rest = &s[first..];
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let mut consumed: Option<usize> = None;
        for (ent, ch) in NAMED_ENTITIES {
            if let Some(after) = tail.strip_prefix(ent) {
                out.push(*ch);
                consumed = Some(ent.len());
                break;
            }
        }
        if consumed.is_none() {
            if let Some((ch, len)) = decode_numeric(tail) {
                out.push(ch);
                consumed = Some(len);
            }
        }
        match consumed {
            Some(len) => rest = &tail[len..],
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Re-emit an attribute, preserving the original quoting style so the
/// output stays byte-close to the input.
fn format_attr(name: &str, value: &str, quote: Option<char>) -> String {
    let name = name.trim_end();
    // Entity decoding can put whitespace or quotes into a value the
    // source emitted unquoted; quote those or the attribute would
    // swallow the rest of the tag.
    let quote = match quote {
        Some(q) => Some(q),
        None if value.chars().any(|c| c.is_ascii_whitespace() || c == '"') => Some('"'),
        None => None,
    };
    match quote {
        Some('"') => format!(
            "{}=\"{}\"",
            name,
            value.replace('&', "&amp;").replace('"', "&quot;")
        ),
        Some('\'') => format!(
            "{}='{}'",
            name,
            value.replace('&', "&amp;").replace('\'', "&#39;")
        ),
        _ => format!("{}={}", name, value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RewriteConfig;
    use crate::encode::Codec;

    fn cfg() -> RewriteConfig {
        RewriteConfig {
            inject_bootstrap: false,
            ..Default::default()
        }
    }

    #[test]
    fn rewrites_attrs_streaming() {
        let base = "https://example.com/a/page.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        // Split mid-tag to prove streaming across chunk boundaries.
        let a = r.process("<html><head></head><body><a href='foo");
        let b = r.process(".html'>x</a><img src=\"/a.png\"></body></html>");
        // Everything before the incomplete tag flushes immediately; only
        // the partial `<a href='foo` is retained across the boundary.
        assert_eq!(a, "<html><head></head><body>");
        let full = format!("{}{}", a, b);
        let enc = |u: &str| {
            let abs = resolve(u, base);
            cfg().encode_url(&abs)
        };
        assert!(
            full.contains(&format!("href='{}'", enc("foo.html"))),
            "got: {}",
            full
        );
        assert!(
            full.contains(&format!("src=\"{}\"", enc("/a.png"))),
            "got: {}",
            full
        );
    }

    #[test]
    fn svg_use_refs_rewrite_and_fragments_stay_client_side() {
        // `<use href>` carries an external sprite reference; without the
        // rewrite it stays a cross-origin URL the engine cannot serve
        // and every icon built from the sprite disappears.
        let base = "https://example.com/app/page.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = format!(
            "{}{}",
            r.process(
                "<svg><use href=\"https://cdn.example.net/sprites.svg#sidebar\"></use></svg>"
            ),
            r.finish()
        );
        let enc_bare = cfg().encode_url("https://cdn.example.net/sprites.svg");
        // Rewritten, with the fragment preserved AFTER the route so the
        // browser still selects the symbol client-side...
        assert!(
            out.contains(&format!("href=\"{}#sidebar\"", enc_bare)),
            "got: {}",
            out
        );
        // ...and the fragment never inside the encoded request target.
        let decoded = out
            .split("href=\"")
            .nth(1)
            .and_then(|s| s.split('#').next())
            .and_then(|route| route.rsplit('/').next())
            .and_then(crate::encode::b64u_decode)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        assert_eq!(decoded, "https://cdn.example.net/sprites.svg");
    }

    #[test]
    fn fragment_only_hrefs_pass_through() {
        // Issue #12: href="#frag" came out as the bare engine prefix +
        // fragment - a route with no encoded destination - so every
        // same-page anchor link navigated to 404 "zeolite: bad route".
        // A fragment-only href must stay untouched: the browser
        // resolves it against the current route client-side.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page.html");
        let out = format!(
            "{}{}",
            r.process("<a href=\"#nav\">skip</a><a href=\"\">empty</a>"),
            r.finish()
        );
        assert!(out.contains("<a href=\"#nav\">"), "got: {}", out);
        assert!(out.contains("<a href=\"\">"), "got: {}", out);
    }

    #[test]
    fn text_flushes_without_lt() {
        // A chunk with no '<' must not be retained: streaming first paint.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("plain text, no markup here at all");
        assert_eq!(a, "plain text, no markup here at all");
        let b = r.process(" and more text");
        assert_eq!(b, " and more text");
    }

    #[test]
    fn injects_bootstrap_once() {
        let c = RewriteConfig::default();
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://example.com/");
        let out = r.process("<html><head><title>t</title></head>");
        assert_eq!(out.matches("bootstrap.js").count(), 1);
        assert!(out.starts_with("<html>"));
    }

    #[test]
    fn injects_hooks_after_head() {
        let c = RewriteConfig::default();
        let mut r = Rewriter::new(c);
        r.add_injection("/hooks/youtube.js");
        r.set_base("https://example.com/");
        let out = r.process("<html><head><title>t</title></head><body></body>");
        let bi = out.find("bootstrap.js").unwrap();
        let hi = out.find("youtube.js").unwrap();
        assert!(bi < hi, "hooks must come after bootstrap: {}", out);
        assert_eq!(out.matches("youtube.js").count(), 1);
    }

    #[test]
    fn style_urls() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = r.process("<style>a{background:url(x.png)}</style>");
        assert!(out.contains("/j/"), "got: {}", out);
    }

    #[test]
    fn comments_pass_through() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = r.process("<!-- <a href='x'> --><p>hi</p>");
        assert!(out.contains("<!-- <a href='x'> -->"));
        assert!(out.contains("<p>hi</p>"));
    }

    #[test]
    fn chunked_text() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let mut out = String::new();
        out.push_str(&r.process("hello world, 1 < 2 and <p"));
        out.push_str(&r.process(">ok</p>"));
        out.push_str(&r.finish());
        assert!(
            out.contains("hello world, 1 < 2 and <p>ok</p>"),
            "got: {}",
            out
        );
    }

    #[test]
    fn partial_tag_retained() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("before <div");
        assert_eq!(a, "before ");
        let b = r.process(" class='x'>after");
        assert!(b.starts_with("<div class='x'>"), "got: {}", b);
        assert!(b.ends_with("after"));
    }

    #[test]
    fn blocks_ad_script_and_img() {
        let c = RewriteConfig {
            block_hosts: vec!["ads.example.net".into(), "tracker.io".into()],
            ..cfg()
        };
        let expected_kept = c.encode_url("https://img.example.com/ok.png");
        let mut r = Rewriter::new(c);
        r.set_base("https://example.com/");
        let out = r.process(
            "<html><head></head><body><script src=\"https://cdn.ads.example.net/x.js\"></script>\
             <img src=\"https://tracker.io/pixel.gif\">\
             <img src=\"https://img.example.com/ok.png\">\
             <a href=\"https://tracker.io/ad\">link text stays</a></body></html>",
        );
        assert!(
            !out.contains("ads.example.net"),
            "blocked script dropped: {}",
            out
        );
        assert!(!out.contains("pixel.gif"), "blocked img dropped: {}", out);
        assert!(
            out.contains(&expected_kept) || out.contains("/j/"),
            "kept img rewritten: {}",
            out
        );
        assert!(
            out.contains("link text stays"),
            "anchor text survives: {}",
            out
        );
        // Anchors are not blockable: navigation is content, not a subresource.
        assert!(out.contains("<a "), "anchor kept: {}", out);
    }

    #[test]
    fn blocked_subdomain_matches() {
        let c = RewriteConfig {
            block_hosts: vec!["doubleclick.net".into()],
            ..cfg()
        };
        let mut r = Rewriter::new(c);
        r.set_base("https://example.com/");
        let out = r.process("<img src=\"https://ad.doubleclick.net/x.gif\">");
        assert!(out.trim().is_empty(), "got: {:?}", out);
    }

    #[test]
    fn engine_routes_never_rewrap_or_bind_to_target() {
        // Issue #1 finding 4: an already-encoded engine route inside a
        // document must survive rewriting unchanged. The old path
        // resolved it against the TARGET base (binding it to the target
        // host: https://target/zl/<b64>, dead cross-origin) and
        // re-encoded it, nesting one more layer per pass.
        let c = RewriteConfig {
            origin: "https://proxy.example".into(),
            codec: Codec::Base64Url {
                prefix: "/zl/".into(),
            },
            ..cfg()
        };
        let dest = "https://chatgpt.com/foo?prompt=1";
        let route = format!("/zl/{}", crate::encode::b64u_encode(dest.as_bytes()));
        let mut r = Rewriter::new(c);
        r.set_base("https://chatgpt.com/");
        let doc = format!("<a href=\"{}\">x</a><img src=\"{}\">", route, route);
        let out = format!("{}{}", r.process(&doc), r.finish());
        assert_eq!(out.matches(&route).count(), 2, "routes unchanged: {}", out);
        assert!(
            !out.contains("https://chatgpt.com/zl/"),
            "no target-host binding: {}",
            out
        );
        assert!(
            !out.contains("https://chatgpt.com/zl/"),
            "no target-host binding: {}",
            out
        );
    }

    #[test]
    fn target_host_bound_routes_unwrap_instead_of_rewrapping() {
        // Issue #1 finding 4, live shape: the loop produces routes
        // bound to the TARGET host (https://google.com/zl/<b64>) which
        // the old guard did not recognize - each pass added another
        // layer until the target's own 404 page answered. The rewriter
        // must peel every layer and emit ONE engine route for the
        // innermost destination.
        let c = RewriteConfig {
            origin: "https://proxy.example".into(),
            codec: Codec::Base64Url {
                prefix: "/zl/".into(),
            },
            ..cfg()
        };
        let dest = "https://www.google.com/search?q=hi";
        let route = format!("/zl/{}", crate::encode::b64u_encode(dest.as_bytes()));
        let bound = format!("https://www.google.com{}", route);
        let nested = format!("/zl/{}", crate::encode::b64u_encode(bound.as_bytes()));
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://www.google.com/");
        let out = format!(
            "{}{}",
            r.process(&format!("<a href=\"{}\">x</a>", nested)),
            r.finish()
        );
        let want = c.encode_url(dest);
        assert!(
            out.contains(&format!("href=\"{}\"", want)),
            "unwrapped to one route: {}",
            out
        );
        // Zero surviving layers: neither bound form appears at all.
        assert!(!out.contains(&bound), "no target-host-bound route: {}", out);
        assert!(!out.contains(&nested), "no nested route: {}", out);
    }

    #[test]
    fn entity_decoding_basics() {
        assert_eq!(decode_entities("plain"), "plain");
        assert_eq!(decode_entities("a&amp;b&#38;c&#x26;d"), "a&b&c&d");
        assert_eq!(decode_entities("&lt;tag&gt;"), "<tag>");
        // Unknown or malformed references pass through untouched.
        assert_eq!(decode_entities("&nbsp;&unknown;&#"), "&nbsp;&unknown;&#");
    }

    #[test]
    fn entity_encoded_urls_decode_before_encoding() {
        // Issue #24: <link href> values carry "&amp;" separators in the
        // source; the DOM sees real "&". Encoding the raw source sent
        // "amp;modules=..." params upstream and load.php answered its
        // error page instead of CSS.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://en.wikipedia.org/wiki/Zeolite");
        let out = format!(
            "{}{}",
            r.process(
                "<link rel=\"stylesheet\" href=\"/w/load.php?lang=en&amp;modules=site.styles&amp;only=styles\">"
            ),
            r.finish()
        );
        let decoded = out
            .split("href=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .and_then(|route| route.rsplit('/').next())
            .and_then(crate::encode::b64u_decode)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        assert_eq!(
            decoded,
            "https://en.wikipedia.org/w/load.php?lang=en&modules=site.styles&only=styles"
        );
    }

    #[test]
    fn numeric_entities_decode_in_urls() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page");
        let out = format!(
            "{}{}",
            r.process("<a href=\"/x?q=1&#38;p=2\">l</a>"),
            r.finish()
        );
        let decoded = out
            .split("href=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .and_then(|route| route.rsplit('/').next())
            .and_then(crate::encode::b64u_decode)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        assert_eq!(decoded, "https://example.com/x?q=1&p=2");
    }

    #[test]
    fn pass_through_values_not_double_escaped() {
        // The DOM value of title="Rock &amp; Roll" is "Rock & Roll"; the
        // emit must re-escape it exactly once, not stack a second
        // escape on the raw source text.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<span title=\"Rock &amp; Roll\">t</span>"),
            r.finish()
        );
        assert!(out.contains("title=\"Rock &amp; Roll\""), "got: {}", out);
        assert!(!out.contains("&amp;amp;"), "got: {}", out);
    }
}
