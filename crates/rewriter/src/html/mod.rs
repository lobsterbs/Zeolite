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
pub mod importmap;
pub mod url_attrs;

use crate::config::RewriteConfig;
use crate::encode::resolve;

/// #322: while a blocked element is swallowed with no close tag yet,
/// the retained buffer is capped: an upstream that never sends the
/// close tag cannot pin the whole rest of the response in memory.
const DROP_RAW_CAP: usize = 256 * 1024;

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
    location_events: std::cell::RefCell<Vec<&'static str>>,
    cfg: RewriteConfig,
    /// Real destination URL of the page being rewritten (page base).
    base: String,
    st: St,
    buf: String,
    /// Lowercase name of the current tag while in Tag/Raw state.
    cur_tag: String,
    /// #369: the current <script> is executable JavaScript by its type.
    cur_script_js: bool,
    /// #554: the current <script> is an import map document by its type.
    cur_script_importmap: bool,
    /// The element being entered was dropped (blocked host): its raw
    /// content and close tag must be swallowed, not emitted.
    drop_raw: bool,
    injected: bool,
    /// A <base href> has been seen: per HTML only the FIRST base
    /// element with a non-empty href folds, later ones are ignored
    /// (issue #36).
    base_seen: bool,
    /// srcdoc nesting depth: recursive sub-document rewrites are
    /// depth-capped so pathological input cannot recurse unbounded.
    depth: u8,
}

impl Rewriter {
    pub fn new(cfg: RewriteConfig) -> Self {
        Self {
            location_events: std::cell::RefCell::new(Vec::new()),
            cfg,
            base: String::new(),
            st: St::Text,
            buf: String::new(),
            cur_tag: String::new(),
            cur_script_js: false,
            cur_script_importmap: false,
            drop_raw: false,
            injected: false,
            base_seen: false,
            depth: 0,
        }
    }

    /// Set before processing. Unknown modes preserve the deployed legacy policy.
    pub fn set_location_policy(&mut self, mode: &str, max_bytes: usize) {
        if !matches!(mode, "legacy" | "hybrid" | "off") {
            return;
        }
        self.cfg.rewrite_globals = mode != "off";
        self.cfg.location_event_attributes = mode == "legacy";
        self.cfg.location_max_bytes = max_bytes.clamp(1, crate::js::globals::MAX_BYTES);
    }

    pub fn take_location_events(&self) -> String {
        self.location_events
            .borrow_mut()
            .drain(..)
            .collect::<Vec<_>>()
            .join(",")
    }

    fn location_body(&self, js: &str) -> String {
        let (out, reason) = if self.cfg.rewrite_globals {
            crate::js::globals::rewrite_with_reason(js, self.cfg.location_max_bytes)
        } else {
            (js.to_owned(), "disabled")
        };
        let mut events = self.location_events.borrow_mut();
        if events.len() < 32 {
            events.push(reason);
        }
        out
    }

    /// Set the page's real destination URL (call before the first chunk).
    pub fn set_base(&mut self, base: &str) {
        self.base = base.to_string();
    }

    /// Replace the block_hosts list (Phase 3 ad/tracker stripping).
    pub fn set_blocked_hosts(&mut self, hosts: Vec<String>) {
        self.cfg.block_hosts = hosts;
    }

    /// Opt-in lazy images (host toggle): see RewriteConfig::lazy_images.
    pub fn set_lazy_images(&mut self) {
        self.cfg.lazy_images = true;
    }

    /// #322: bound the swallow buffer of a blocked element whose close
    /// tag has not arrived. The normal raw path must mirror the
    /// browser's own raw-text buffering (a cap would truncate legit
    /// large scripts), but a blocked element's content is dropped
    /// either way: the swallowed prefix is discarded and exactly the
    /// longest suffix that could still be a prefix of the close
    /// marker is kept (eat_comment's keep-3 technique, here for the
    /// element's own close tag), so no close tag can be missed.
    fn trim_drop_raw(&mut self) {
        if !self.drop_raw || self.buf.len() <= DROP_RAW_CAP || self.cur_tag.is_empty() {
            return;
        }
        let marker: Vec<u8> = format!("</{}", self.cur_tag)
            .bytes()
            .map(|b| b.to_ascii_lowercase())
            .collect();
        let bytes = self.buf.as_bytes();
        let mut keep = 0;
        for k in 1..=marker.len().min(bytes.len()) {
            if bytes[bytes.len() - k..].eq_ignore_ascii_case(&marker[..k]) {
                keep = k;
            }
        }
        let mut cut = bytes.len() - keep;
        while cut > 0 && !self.buf.is_char_boundary(cut) {
            cut -= 1;
        }
        self.buf.drain(..cut);
    }

    /// Add a script path to inject after <head> opens (Phase 3 hooks).
    pub fn add_injection(&mut self, path: &str) {
        self.cfg.injections.push(path.to_string());
    }

    fn enc(&self, url: &str) -> String {
        self.enc_route(url, false, false)
    }

    /// JS string-literal routing (#112): like enc(), but a keyed
    /// route for a directory-shaped destination (path ending in "/")
    /// keeps the last path segment visible after the token. Pages
    /// branch on the tail of such base strings (reCAPTCHA's
    /// enterprise loader appends "api2/" unless its api base ends
    /// with "enterprise/"), and a fully opaque token breaks every
    /// tail check. The split form still routes: recoverPath
    /// (app/src/codec.ts) decodes token(parent) + "/seg/..." back
    /// to parent + "/seg/...". Keyed codec only: recoverPath refuses
    /// legacy tails, so a split legacy route would 404 instead of
    /// decoding.
    fn enc_literal(&self, url: &str) -> String {
        self.enc_route(url, true, false)
    }

    /// Script src/href attr routing (#296 class, the YouTube ytembeds
    /// "base-js" strand): pages locate and validate their own loader
    /// script by the SHAPE of its src path (the ytembeds bootstrap
    /// requires "/_/js/" and "/k=" in the path before it defines
    /// writeEmbed; Google basejs builds chunk URLs by surgery on the
    /// src path). An opaque /zl/<token> route fails every such check,
    /// so the script mint keeps the real path visible:
    /// see enc_script_final.
    fn enc_script(&self, url: &str) -> String {
        self.enc_route(url, false, true)
    }

    /// #499: true when the absolute URL carries userinfo before the
    /// first path, query or fragment byte (scheme://user[:pass]@host).
    /// A @ elsewhere (path, query, fragment) is not userinfo.
    fn userinfo_in_authority(abs: &str) -> bool {
        let Some((_, rest)) = abs.split_once("://") else {
            return false;
        };
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        rest[..end].contains("@")
    }

    fn enc_route(&self, url: &str, literal: bool, script: bool) -> String {
        // Already engine-local (nested rewriting): keep as-is. An empty
        // origin matches every URL, so it must not take this branch.
        if !self.cfg.origin.is_empty() && url.starts_with(&self.cfg.origin) {
            // Bug-scout fix: a bare prefix match let a same-suffix
            // host pass as engine-local (https://e.example.evil.com
            // when the engine origin is https://e.example.com); the
            // byte after the origin must be a URL boundary: end,
            // '/', '?' or '#'.
            let rest = &url[self.cfg.origin.len()..];
            if rest.is_empty()
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
            {
                return url.to_string();
            }
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
                let mut out = self.enc_final(&bare, literal, script);
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
        // #499: a userinfo-carrying absolute URL (scheme://key@host)
        // is configuration-shaped data, not a navigation sink:
        // Sentry DSNs and credential-bearing config strings are
        // parsed by application JS as written, and an engine route
        // fails those parsers (Invalid Sentry Dsn). JS literals
        // are data until a runtime sink consumes them, and the
        // runtime seams still route the eventual request, so the
        // literal keeps its verbatim value. Only the authority is
        // inspected: an @ in a path or query is not userinfo.
        // HTML attributes and script srcs are browser-owned sinks
        // and keep routing (the literal gate below).
        if literal && Self::userinfo_in_authority(&abs) {
            return abs;
        }
        // Opaque absolute URLs (data:, blob:, about:, javascript:,
        // mailto:, tel:, or any non-http(s) scheme) never route
        // through the engine: the upstream fetcher cannot honor them
        // and their payload is client-side anyway. resolve() already
        // passes them through; keep them unwrapped so the DOM sees
        // the original value (issue #36: opaque URLs are not
        // double-wrapped).
        if let Some(ci) = abs.find(':') {
            let sch = &abs[..ci];
            if crate::encode::is_scheme(sch)
                && !sch.eq_ignore_ascii_case("http")
                && !sch.eq_ignore_ascii_case("https")
            {
                return abs;
            }
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
        let mut out = self.enc_final(&bare, literal, script);
        out.push_str(&frag);
        out
    }

    /// Final encode of a bare destination. JS literals under the
    /// keyed codec keep the last path segment of a directory-shaped
    /// destination visible (#112): see enc_literal.
    fn enc_final(&self, bare: &str, literal: bool, script: bool) -> String {
        if script {
            if let Some(split) = self.enc_script_final(bare) {
                return split;
            }
            // Legacy codec, bare origin, or a path past the
            // recoverPath cap: the opaque route stays (an honest
            // residual - there is no decodeable split form).
        }
        if literal && matches!(self.cfg.codec, crate::encode::Codec::Keyed { .. }) {
            if let Some((parent, seg)) = Self::split_dir_dest(bare) {
                let mut o = self.cfg.encode_url(parent);
                o.push('/');
                o.push_str(seg);
                o.push('/');
                return o;
            }
        }
        self.cfg.encode_url(bare)
    }

    /// Path-preserving split route for script src/href attributes
    /// (#296 class): the keyed token carries ONLY the origin and the
    /// real path and query ride verbatim after it:
    /// <origin>/zl/<origin-token>/real/path?real=query. The SW decodes
    /// it with recoverPath (token prefix MAC-verified, remainder
    /// appended to the decoded origin) and the fetch merge seam
    /// re-attaches the route search, so no SW-side change is needed;
    /// the same decode already serves the #112 directory-split
    /// literal routes. Keyed codec only: recoverPath refuses legacy
    /// split tails. recoverPath rejects tails over 2048 chars, so a
    /// longer path keeps the opaque route; a destination without a
    /// path keeps it too (no shape to preserve).
    fn enc_script_final(&self, bare: &str) -> Option<String> {
        let (prefix, key) = match &self.cfg.codec {
            crate::encode::Codec::Keyed { prefix, key } => (prefix, key),
            _ => return None,
        };
        let scheme_end = bare.find("://")? + 3;
        let host_end = bare[scheme_end..]
            .find(['/', '?'])
            .map(|i| i + scheme_end)?;
        let origin = &bare[..host_end];
        let rest = &bare[host_end..];
        if !rest.starts_with('/') {
            return None;
        }
        let token = crate::encode::b64u_encode(&crate::encode::keyed_token(key, origin.as_bytes()));
        let path_len = rest.find('?').unwrap_or(rest.len());
        if token.len() + path_len > 2000 {
            return None; // recoverPath cap is 2048; keep headroom
        }
        Some(format!("{}{}{}{}", self.cfg.origin, prefix, token, rest))
    }

    /// #554: route a URL-like PREFIX key (an import map key or scope
    /// key ending in "/") into the path-preserving split shape the
    /// keyed codec can decode: the token carries ONLY the origin and
    /// the real path rides verbatim after it, so the prefix stays
    /// visible for the browser prefix matching against page-space
    /// module URLs (script srcs use the same split form). None when
    /// the codec has no split form (a plain Base64Url route hides the
    /// path inside the token, so no route string can prefix-match),
    /// or the key is opaque, carries a query/fragment, or is too
    /// long: the caller keeps the entry verbatim, which never matched
    /// through the engine before either.
    fn enc_split_route(&self, url: &str) -> Option<String> {
        let mut abs = crate::encode::resolve(url, &self.base);
        if let Some(innermost) = self.cfg.unwrap_engine_route(&abs) {
            if innermost.starts_with("http://") || innermost.starts_with("https://") {
                abs = innermost;
            }
        }
        if !abs.starts_with("http://") && !abs.starts_with("https://") {
            return None;
        }
        if abs.contains('#') || abs.contains('?') {
            return None;
        }
        let (prefix, key) = match &self.cfg.codec {
            crate::encode::Codec::Keyed { prefix, key } => (prefix, key),
            _ => return None,
        };
        let scheme_end = abs.find("://")? + 3;
        let host_end = abs[scheme_end..].find('/').map(|i| i + scheme_end)?;
        let origin = &abs[..host_end];
        let rest = &abs[host_end..];
        if rest.len() > 2000 {
            return None; // recoverPath cap is 2048; keep headroom
        }
        let token = crate::encode::b64u_encode(&crate::encode::keyed_token(key, origin.as_bytes()));
        Some(format!("{}{}{}{}", self.cfg.origin, prefix, token, rest))
    }

    /// Split a directory-shaped destination (path ending in "/") into
    /// (parent, last visible path segment): "https://e.com/a/b/" ->
    /// ("https://e.com/a", "b"). None when there is no segment to
    /// keep visible (root-only "/" or empty paths).
    fn split_dir_dest(bare: &str) -> Option<(&str, &str)> {
        let one = bare.strip_suffix('/')?;
        let scheme_end = one.find("://")? + 3;
        let path_start = one[scheme_end..].find('/').map(|i| i + scheme_end)?;
        let seg_slash = one.rfind('/')?;
        if seg_slash < path_start {
            return None;
        }
        Some((&one[..seg_slash], &one[seg_slash + 1..]))
    }

    /// One-shot external-script body pass (#46): URL-literal rewriting
    /// plus frame-buster neutralization — the same pipeline inline
    /// <script> bodies get from the Raw state. External script bodies
    /// never enter the HTML tokenizer, so the SW applies this at the
    /// serve seam instead; `self.base` is the script's own URL.
    pub fn rewrite_js_body(&self, js: &str) -> String {
        if !self.cfg.rewrite_js_literals {
            return js.to_string();
        }
        let rewritten = crate::js::rewrite_script(js, &|u| self.enc_literal(u));
        let neutral = crate::js::antiframe(&rewritten);
        // #235: location reads rename to the virtual location global
        // (#236) after the literal and frame-buster passes, so the
        // parse gate sees the final body.
        self.location_body(&neutral)
    }

    /// Rewrite an iframe srcdoc document (issue #36). The attribute
    /// value reaches the DOM entity-decoded, so the decoded value IS
    /// an HTML document: rewrite it as a nested sub-document with the
    /// same config and the same page base, and let format_attr
    /// re-escape the result on emit. Depth-capped: a srcdoc inside a
    /// srcdoc inside... grows superlinearly, so pathological input
    /// cannot recurse without bound. The sub-document inherits the
    /// bootstrap injection config, which is correct: an about:srcdoc
    /// document is a fresh browsing context that otherwise runs none
    /// of the engine runtime.
    fn rewrite_srcdoc(&self, v: &str) -> String {
        const MAX_SRCDOC_DEPTH: u8 = 4;
        if self.depth >= MAX_SRCDOC_DEPTH {
            return v.to_string();
        }
        let mut sub = Rewriter::new(self.cfg.clone());
        sub.depth = self.depth + 1;
        sub.set_base(&self.base);
        format!("{}{}", sub.process(v), sub.finish())
    }

    /// Rewrite the content attribute of <meta http-equiv=refresh>
    /// (issue #36). Supported forms: "5" (plain reload: untouched),
    /// "5; url=/x", "5;,url=/x", "0; url='x'" (quoted target,
    /// either quote). Anything without a url= part passes through
    /// unchanged; the delay part is preserved as written.
    fn rewrite_refresh_content(&self, v: &str) -> String {
        let Some((delay, tail)) = v.split_once(';') else {
            return v.to_string();
        };
        let t = tail.trim_start();
        let t = t.strip_prefix(',').unwrap_or(t).trim_start();
        if !t.to_ascii_lowercase().starts_with("url") {
            return v.to_string();
        }
        let after = t[3..].trim_start();
        let Some(u) = after.strip_prefix('=') else {
            return v.to_string();
        };
        let u = u.trim();
        let (quote, inner) = match u.as_bytes().first() {
            Some(&b'"') if u.len() > 1 && u.ends_with('"') => (Some('"'), &u[1..u.len() - 1]),
            Some(&b'\'') if u.len() > 1 && u.ends_with('\'') => (Some('\''), &u[1..u.len() - 1]),
            _ => (None, u),
        };
        let inner = inner.trim();
        if inner.is_empty() {
            return v.to_string();
        }
        let new = self.enc(inner);
        match quote {
            Some(q) => format!("{}; url={}{}{}", delay.trim(), q, new, q),
            None => format!("{}; url={}", delay.trim(), new),
        }
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
                    // #174: HTML ends comments at "--!>" too;
                    // whichever marker arrives first closes them.
                    if !eat_comment(&mut self.buf, &mut out) {
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
                    // Hold the buffer in a local so rewriting a tag
                    // can mutate self (<base href> switches the
                    // folding base, issue #36) without borrowing buf.
                    let mut buf = std::mem::take(&mut self.buf);
                    let matched = self.try_rewrite_tag(&buf);
                    match matched {
                        Some((end, rewritten)) => {
                            // #187: the element name comes from the
                            // COMPLETED tag, not whatever partial text
                            // classify_open saw when the tag split
                            // across chunks ("<scr" + "ipt>").
                            let open = !buf.starts_with("</");
                            if open {
                                self.cur_tag = elem_name(&buf[..end]);
                                self.cur_script_js = script_type_is_js(&buf[..end]);
                                self.cur_script_importmap = script_type_is_importmap(&buf[..end]);
                            } else {
                                self.cur_tag.clear();
                            }
                            out.push_str(&rewritten);
                            buf.drain(..end);
                            self.buf = buf;
                            let raw = open && is_raw_tag(&self.cur_tag);
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
                        None => {
                            self.buf = buf;
                            break; // incomplete tag: wait for more input
                        }
                    }
                }
                St::Raw => {
                    let close = format!("</{}", self.cur_tag);
                    // #188: the match requires a TERMINATED close tag
                    // (whitespace, '/' or '>' after the name): the
                    // string "</scripts" inside a script body never
                    // ends the block.
                    // #339: script raw content has escaped states
                    // per the HTML tokenizer: "<!--" enters escaped,
                    // "<script" inside escaped enters double-escaped,
                    // and a terminated close tag inside double-escaped
                    // returns to escaped without ending the element.
                    // "-->" returns either escaped state to plain data.
                    // The plain search closed at the first
                    // inner </script> of a double-escaped block,
                    // leaving the tail parsed as markup: literal URLs
                    // unrewritten, antiframe skipped.
                    let found = if self.cur_tag == "script" {
                        find_script_close(&self.buf)
                    } else {
                        find_ci_terminated(&self.buf, &close)
                            .and_then(|ci| self.buf[ci..].find('>').map(|k| (ci, ci + k + 1)))
                    };
                    let Some((ci, end)) = found else {
                        self.trim_drop_raw();
                        break;
                    };
                    if self.drop_raw {
                        // Blocked element: swallow content + close tag.
                        self.buf.drain(..end);
                    } else {
                        let raw = self.buf[..ci].to_string();
                        if self.cur_tag == "script" && self.cur_script_importmap {
                            /* #554: an import map body is JSON data, not
                            JavaScript; its target URLs route exactly the
                            way a script src would (values and URL-like
                            keys), so mapped modules stay engine-routed
                            instead of escaping browser-direct. Invalid
                            JSON passes through unchanged and fails the
                            map with the native error. */
                            out.push_str(&importmap::rewrite_importmap(
                                &raw,
                                &|u| self.enc(u),
                                &|u| self.enc_split_route(u),
                                &|u| self.enc_split_route(u),
                            ));
                        } else if self.cur_tag == "style" && self.cfg.rewrite_css {
                            out.push_str(&css::rewrite_stylesheet(&raw, &|u| self.enc(u)));
                        } else if self.cur_tag == "script"
                            && self.cfg.rewrite_js_literals
                            && self.cur_script_js
                        {
                            // Frame-buster neutralization runs AFTER the
                            // URL-literal pass (same order as the server
                            // engine's pipeline) so folded guards and
                            // navigation sinks apply to the final body.
                            let rewritten =
                                crate::js::rewrite_script(&raw, &|u| self.enc_literal(u));
                            let neutral = crate::js::antiframe(&rewritten);
                            // #235: the same globals pass the external
                            // body path runs, on the final body.
                            let with_globals = self.location_body(&neutral);
                            out.push_str(&with_globals);
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
    fn try_rewrite_tag(&mut self, buf: &str) -> Option<(usize, String)> {
        // Find the '>' that closes the tag, respecting quoted attr values.
        let bytes = buf.as_bytes();
        let mut i = 1; // past '<'
        if i < bytes.len() && bytes[i] == b'/' {
            i += 1;
        }
        // #175: a quote opens a quoted VALUE only immediately after
        // '='; anywhere else it is an ordinary character. Tracking
        // quotes anywhere made '<p class=it\'s>' swallow the rest of
        // the document hunting a closing quote.
        let mut quote: Option<u8> = None;
        let mut prev = b'x'; // any non-'=' starter
        while i < bytes.len() {
            let b = bytes[i];
            match quote {
                Some(q) => {
                    if b == q {
                        quote = None;
                    }
                }
                None => {
                    if (b == b'"' || b == b'\'') && prev == b'=' {
                        quote = Some(b);
                    } else if b == b'>' {
                        break;
                    }
                }
            }
            prev = b;
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
    fn rewrite_single_tag(&mut self, raw: &str) -> String {
        let name_end = raw[1..]
            .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
            .map(|i| i + 1)
            .unwrap_or(raw.len());
        let name = raw[1..name_end].to_ascii_lowercase();
        let mut out = String::with_capacity(raw.len() + 64);
        out.push('<');
        out.push_str(&raw[1..name_end]);
        let mut rest = &raw[name_end..];
        // The close-tag slash is tag syntax, not an attribute
        // separator: never fold it in next_attr (#173 regression
        // let </head> come out as <head>).
        let close_tag = raw.starts_with("</");
        // <meta http-equiv=refresh> carries its navigation target in
        // the content attribute (issue #36): "5; url=/next". The
        // http-equiv attribute can appear before or after content,
        // so decide with a pre-scan before rewriting any value. The
        // same scan flags CSP meta tags: the header form is stripped
        // in app/src/headers (HOSTILE list) because rewritten
        // subresources ride engine-origin routes the original
        // directives never allow, and a surviving meta CSP would
        // block them the same way (bug-scout issue 3). Dropping the
        // tag matches the header policy; rewriting a policy to match
        // engine routes is out of scope for the streaming pass.
        let mut is_csp_meta = false;
        let mut is_refresh = false;
        if name == "meta" {
            let mut scan = rest;
            while let Some(a) = next_attr(scan, true) {
                if a.name.eq_ignore_ascii_case("http-equiv") {
                    if let Some(val) = a.value.as_deref() {
                        let v = val.trim().to_ascii_lowercase();
                        if v == "refresh" {
                            is_refresh = true;
                        } else if v == "content-security-policy"
                            || v == "content-security-policy-report-only"
                        {
                            is_csp_meta = true;
                        }
                    }
                }
                scan = &scan[a.consumed..];
            }
        }
        if is_csp_meta {
            return String::new();
        }
        let mut first_url: Option<String> = None;
        let mut has_loading = false;
        while let Some(attr) = next_attr(rest, !close_tag) {
            let Attr {
                consumed,
                lead_ws,
                name: attr_name,
                value: attr_value,
                quote,
            } = attr;
            let lower = attr_name.to_ascii_lowercase();
            if lower == "loading" {
                has_loading = true;
            }
            // SRI hashes are computed over the upstream bytes; the
            // rewritten subresource always differs (URLs folded
            // into engine routes), so the browser silently refuses
            // it on integrity mismatch (issue #77). Recomputing
            // hashes over streamed rewritten output is impractical,
            // so drop the attribute instead. crossorigin stays
            // untouched.
            if lower == "integrity" {
                rest = &rest[consumed..];
                continue;
            }
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
                    } else if lower == "srcdoc" && name == "iframe" {
                        Some(self.rewrite_srcdoc(&v))
                    } else if name == "meta" && lower == "content" && is_refresh {
                        Some(self.rewrite_refresh_content(&v))
                    } else if lower == "ping" && (name == "a" || name == "area") {
                        // ping is a space-separated URL list.
                        Some(
                            v.split_whitespace()
                                .map(|u| self.enc(u))
                                .collect::<Vec<_>>()
                                .join(" "),
                        )
                    } else if url_attrs::is_svg_paint_attr(&name, &lower) {
                        Some(url_attrs::rewrite_svg_paint(&v, &|u| self.enc(u)))
                    } else if lower == "style" && self.cfg.rewrite_css {
                        Some(css::rewrite_stylesheet(&v, &|u| self.enc(u)))
                    } else if url_attrs::is_url_attr(&name, &lower) {
                        // Challenge-provider script srcs stay
                        // provider-direct (#123): Turnstile's api.js
                        // locates its own <script> tag by the original
                        // src, silently no-ops on a routed src, and the
                        // widget never injects (infinite spinner).
                        if name == "script"
                            && matches!(lower.as_str(), "src" | "href")
                            && url_attrs::is_challenge_script_src(&resolve(&v, &self.base))
                        {
                            None
                        } else {
                            let mut e =
                                if name == "script" && matches!(lower.as_str(), "src" | "href") {
                                    self.enc_script(&v)
                                } else {
                                    self.enc(&v)
                                };
                            // #161-class self-location: pages find their
                            // own stub <script> by substring on the
                            // ORIGINAL src (OneTrust:
                            // script[src*='otBannerSdk.js']). An opaque
                            // route loses the filename, the lookup
                            // returns null and the CMP crashes. The
                            // destination's last path segment rides as a
                            // FRAGMENT on the route: substring matching
                            // works again, and a fragment is client-side
                            // only, so the fetch target is unchanged
                            // (browsers strip it before the request;
                            // resolve/decode never encode it). Scoped to
                            // script src only: challenge srcs stay
                            // provider-direct above and anchor href
                            // fragments carry real semantics.
                            if name == "script" && lower == "src" && !e.contains('#') {
                                let abs = resolve(&v, &self.base);
                                let dest = self.cfg.unwrap_engine_route(&abs).unwrap_or(abs);
                                if let Some(seg) = last_path_segment(&dest) {
                                    e.push('#');
                                    e.push_str(seg);
                                }
                            }
                            // <base href> switches the folding base for
                            // every later relative URL (issue #36). Per
                            // HTML only the first base with a non-empty
                            // href counts, and the base's own href is
                            // resolved against the page base BEFORE it
                            // takes effect. An already-encoded route
                            // folds against its innermost destination,
                            // never the host the route text is bound to.
                            if name == "base" && lower == "href" && !self.base_seen {
                                let folded = resolve(&v, &self.base);
                                let folded = match self.cfg.decode_engine_route(&folded) {
                                    Some(inner) => inner,
                                    None => folded,
                                };
                                if folded.starts_with("http://") || folded.starts_with("https://") {
                                    self.base = folded;
                                    self.base_seen = true;
                                }
                            }
                            Some(e)
                        }
                    } else if is_event_attr(&lower) && self.cfg.rewrite_js_literals {
                        let neutral = crate::js::antiframe(&crate::js::rewrite_inline(&v, &|u| {
                            self.enc_literal(u)
                        }));
                        // #241: handlers read the same virtual
                        // location as script bodies.
                        Some(
                            if self.cfg.rewrite_globals && self.cfg.location_event_attributes {
                                crate::js::globals::rewrite_globals(&neutral)
                            } else {
                                neutral
                            },
                        )
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
        // Lazy images (host toggle): an <img> with no loading attribute
        // gets loading=\"lazy\", so off-screen images defer until
        // they approach the viewport. An explicit author choice is kept.
        if self.cfg.lazy_images && name == "img" && !has_loading {
            out.push_str(" loading=\"lazy\"");
        }
        out.push_str(rest);
        out
    }
}

/// The last path segment of an absolute URL, query and fragment
/// stripped ("https://c.com/a/b/sdk.js?v=2" -> "sdk.js"). None when
/// there is no '/' after the authority (no path) or the path ends at
/// the root (no segment to expose).
fn last_path_segment(abs: &str) -> Option<&str> {
    let bare = abs.split(['#', '?']).next().unwrap_or(abs);
    let auth = bare.find("://")? + 3;
    let path_start = bare[auth..].find('/')? + auth;
    let seg = bare[path_start..].rsplit('/').next()?;
    if seg.is_empty() {
        None
    } else {
        Some(seg)
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
        // #190: a partial "<!" or "<!-" can still become "<!--";
        // wait for more input instead of classifying the comment open
        // as a doctype and losing the rest of the document.
        if buf.len() < 4 && "<!--".starts_with(buf) {
            return None;
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

/// The element name of a complete tag, lowercased, ignoring the
/// leading '/' of close tags. #187: cur_tag must be derived from
/// the COMPLETED tag, not the partial text classify_open saw when
/// the tag split across chunks ("<scr" + "ipt>").
/// The decoded, lowercased, parameter-stripped type attribute of a
/// <script> open tag, or None when the tag carries no type attribute.
/// #554 factored the shared classification out of script_type_is_js so
/// the import map pass answers "is this an import map" from the same
/// tokenizer instead of a second, drifting one.
fn script_type_value(tag: &str) -> Option<String> {
    // #448: use the same attribute tokenizer as the markup rewrite.
    // Searching for " type" also matches text inside a quoted value.
    let tag = tag.strip_prefix('<').unwrap_or(tag);
    let name_end = tag
        .find(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>')
        .unwrap_or(tag.len());
    let mut rest = &tag[name_end..];
    while let Some(attr) = next_attr(rest, true) {
        if attr.name.eq_ignore_ascii_case("type") {
            let decoded = decode_entities(attr.value.as_deref().unwrap_or(""));
            let lower = decoded.to_ascii_lowercase();
            return Some(lower.split(';').next().unwrap_or("").trim().to_string());
        }
        rest = &rest[attr.consumed..];
    }
    None
}

/// #369: whether a <script> open tag carries executable JavaScript.
/// No `type`, an empty one, or a JavaScript MIME type (parameters like
/// `;charset=` ignored) is executable; anything else (application/json,
/// application/ld+json, text/template, importmap, ...) is data.
fn script_type_is_js(tag: &str) -> bool {
    match script_type_value(tag) {
        None => true,
        Some(value) => matches!(
            value.as_str(),
            "" | "module"
                | "text/javascript"
                | "application/javascript"
                | "application/x-javascript"
                | "text/ecmascript"
                | "application/ecmascript"
                | "text/jscript"
                | "text/livescript"
        ),
    }
}

/// #554: the current <script> is an import map document by its type.
fn script_type_is_importmap(tag: &str) -> bool {
    matches!(script_type_value(tag), Some(v) if v == "importmap")
}

fn elem_name(tag: &str) -> String {
    let t = tag.strip_prefix('<').unwrap_or(tag);
    let t = t.strip_prefix('/').unwrap_or(t);
    t.chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn is_raw_tag(tag: &str) -> bool {
    // #207: RCDATA (title, textarea) and RAWTEXT (iframe, noembed,
    // xmp) content is visible text, never markup - the browser never
    // parses tags inside them, so rewriting it corrupts what the user
    // sees. Raw state emits their content verbatim.
    matches!(
        tag,
        "script" | "style" | "title" | "textarea" | "iframe" | "noembed" | "xmp"
    )
}

fn is_event_attr(attr: &str) -> bool {
    attr.starts_with("on") && attr.len() > 2
}

/// Case-insensitive find of a TERMINATED raw-close tag, ASCII only
/// (#188): the byte after the match must be whitespace, '/' or '>',
/// per HTML's raw-text end-tag rules. A match at the very end of the
/// input returns None: the terminator may still arrive in a later
/// chunk, so the caller waits instead of cutting.
/// #339: locate a script element's close tag per the HTML
/// tokenizer's escaped states: "<!--" enters script-data-escaped,
/// "<script" inside escaped enters double-escaped, and a terminated
/// "</script" inside double-escaped does NOT close the element
/// but returns to escaped, where a following close tag ends it.
/// "-->" returns both escaped states to plain script data. #447:
/// a delimiter must follow the <script marker, so <scripts is text.
/// #397: the tag markers match ASCII
/// case-insensitively (the HTML tokenizer compares the
/// script-data-escaped markers case-insensitively, so a
/// </SCRIPT> close is a real close); <!-- and --> carry no letters.
/// Returns (start of "</script", index just past its '>').
fn starts_ci(b: &[u8], needle: &[u8]) -> bool {
    b.len() >= needle.len() && b[..needle.len()].eq_ignore_ascii_case(needle)
}

fn find_script_close(buf: &str) -> Option<(usize, usize)> {
    let b = buf.as_bytes();
    let mut i = 0usize;
    let mut escaped = false;
    let mut double_escaped = false;
    while i < b.len() {
        if !escaped && starts_ci(&b[i..], b"<!--") {
            escaped = true;
            i += 4;
            continue;
        }
        if escaped
            && !double_escaped
            && starts_ci(&b[i..], b"<script")
            && b.get(i + 7)
                .is_some_and(|c| matches!(c, b' ' | b'\t' | b'\n' | 0x0c | b'\r' | b'/' | b'>'))
        {
            double_escaped = true;
            i += 7;
            continue;
        }
        if escaped && starts_ci(&b[i..], b"-->") {
            double_escaped = false;
            escaped = false;
            i += 3;
            continue;
        }
        if starts_ci(&b[i..], b"</script") {
            let after = i + 8;
            if after < b.len()
                && matches!(b[after], b' ' | b'\t' | b'\n' | 0x0c | b'\r' | b'/' | b'>')
            {
                if double_escaped {
                    double_escaped = false;
                    i = after;
                    continue;
                }
                let end = buf[after..].find('>').map(|k| after + k + 1)?;
                return Some((i, end));
            }
        }
        i += 1;
    }
    None
}

fn find_ci_terminated(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| {
        h[i..i + n.len()].eq_ignore_ascii_case(n)
            && match h.get(i + n.len()) {
                Some(&b) => matches!(b, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r' | b'/' | b'>'),
                None => false,
            }
    })
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

/// Comment variant: the block ends at whichever of "-->" or "--!>"
/// arrives first (#174), and the retained tail cuts only on a char
/// boundary (#177: a slice inside a multibyte character panics the
/// wasm call and fails the whole page).
fn eat_comment(buf: &mut String, out: &mut String) -> bool {
    let end = ["-->", "--!>"]
        .iter()
        .filter_map(|m| buf.find(*m).map(|i| i + m.len()))
        .min();
    if let Some(end) = end {
        out.push_str(&buf[..end]);
        buf.drain(..end);
        return true;
    }
    // No full marker yet: keep a tail that could still become one.
    let keep = 3; // longest partial marker: "--!" (for "--!>")
    let mut cut = buf.len().saturating_sub(keep);
    while cut > 0 && !buf.is_char_boundary(cut) {
        cut -= 1;
    }
    out.push_str(&buf[..cut]);
    buf.drain(..cut);
    false
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
fn next_attr(s: &str, fold_slash: bool) -> Option<Attr> {
    let trimmed = s.trim_start();
    let lead_ws = s[..s.len() - trimmed.len()].to_string();
    if trimmed.is_empty() || trimmed.starts_with('>') || trimmed.starts_with("/>") {
        return None;
    }
    // #173: a lone '/' between attributes is a separator (HTML5
    // parity); it never joins the name, so '<img/src=...>' rewrites
    // like any src. "/>" already ended the attribute list above.
    // On a CLOSE tag the leading '/' is tag syntax, not a separator
    // (folding it turned </head> into <head>), so the caller passes
    // fold_slash = false for close tags.
    let sep = usize::from(fold_slash && trimmed.starts_with('/'));
    let trimmed = &trimmed[sep..];
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
        let consumed = lead_ws.len() + sep + eq + consumed_v;
        return Some(Attr {
            consumed,
            lead_ws,
            name,
            value: Some(val),
            quote,
        });
    }
    // Boolean attribute (no value).
    let consumed = lead_ws.len() + sep + name_end;
    Some(Attr {
        consumed,
        lead_ws,
        name,
        value: None,
        quote: None,
    })
}

/// The full HTML4 named-entity table plus the two apostrophe
/// spellings (numeric and named): decode_entities mirrors what the
/// browser's HTML parser hands the DOM for any source spelling, and
/// format_attr re-escapes the decoded value on emit, so pass-through
/// values stay DOM-stable across repeated rewrite passes. Unknown or
/// malformed references are still left for the browser.
const NAMED_ENTITIES: &[(&str, char)] = &[
    ("&#39;", '\u{27}'),
    ("&AElig;", '\u{c6}'),
    ("&Aacute;", '\u{c1}'),
    ("&Acirc;", '\u{c2}'),
    ("&Agrave;", '\u{c0}'),
    ("&Alpha;", '\u{391}'),
    ("&Aring;", '\u{c5}'),
    ("&Atilde;", '\u{c3}'),
    ("&Auml;", '\u{c4}'),
    ("&Beta;", '\u{392}'),
    ("&Ccedil;", '\u{c7}'),
    ("&Chi;", '\u{3a7}'),
    ("&Dagger;", '\u{2021}'),
    ("&Delta;", '\u{394}'),
    ("&ETH;", '\u{d0}'),
    ("&Eacute;", '\u{c9}'),
    ("&Ecirc;", '\u{ca}'),
    ("&Egrave;", '\u{c8}'),
    ("&Epsilon;", '\u{395}'),
    ("&Eta;", '\u{397}'),
    ("&Euml;", '\u{cb}'),
    ("&Gamma;", '\u{393}'),
    ("&Iacute;", '\u{cd}'),
    ("&Icirc;", '\u{ce}'),
    ("&Igrave;", '\u{cc}'),
    ("&Iota;", '\u{399}'),
    ("&Iuml;", '\u{cf}'),
    ("&Kappa;", '\u{39a}'),
    ("&Lambda;", '\u{39b}'),
    ("&Mu;", '\u{39c}'),
    ("&Ntilde;", '\u{d1}'),
    ("&Nu;", '\u{39d}'),
    ("&OElig;", '\u{152}'),
    ("&Oacute;", '\u{d3}'),
    ("&Ocirc;", '\u{d4}'),
    ("&Ograve;", '\u{d2}'),
    ("&Omega;", '\u{3a9}'),
    ("&Omicron;", '\u{39f}'),
    ("&Oslash;", '\u{d8}'),
    ("&Otilde;", '\u{d5}'),
    ("&Ouml;", '\u{d6}'),
    ("&Phi;", '\u{3a6}'),
    ("&Pi;", '\u{3a0}'),
    ("&Prime;", '\u{2033}'),
    ("&Psi;", '\u{3a8}'),
    ("&Rho;", '\u{3a1}'),
    ("&Scaron;", '\u{160}'),
    ("&Sigma;", '\u{3a3}'),
    ("&THORN;", '\u{de}'),
    ("&Tau;", '\u{3a4}'),
    ("&Theta;", '\u{398}'),
    ("&Uacute;", '\u{da}'),
    ("&Ucirc;", '\u{db}'),
    ("&Ugrave;", '\u{d9}'),
    ("&Upsilon;", '\u{3a5}'),
    ("&Uuml;", '\u{dc}'),
    ("&Xi;", '\u{39e}'),
    ("&Yacute;", '\u{dd}'),
    ("&Yuml;", '\u{178}'),
    ("&Zeta;", '\u{396}'),
    ("&aacute;", '\u{e1}'),
    ("&acirc;", '\u{e2}'),
    ("&acute;", '\u{b4}'),
    ("&aelig;", '\u{e6}'),
    ("&agrave;", '\u{e0}'),
    ("&alefsym;", '\u{2135}'),
    ("&alpha;", '\u{3b1}'),
    ("&amp;", '\u{26}'),
    ("&and;", '\u{2227}'),
    ("&ang;", '\u{2220}'),
    ("&apos;", '\u{27}'),
    ("&aring;", '\u{e5}'),
    ("&asymp;", '\u{2248}'),
    ("&atilde;", '\u{e3}'),
    ("&auml;", '\u{e4}'),
    ("&bdquo;", '\u{201e}'),
    ("&beta;", '\u{3b2}'),
    ("&brvbar;", '\u{a6}'),
    ("&bull;", '\u{2022}'),
    ("&cap;", '\u{2229}'),
    ("&ccedil;", '\u{e7}'),
    ("&cedil;", '\u{b8}'),
    ("&cent;", '\u{a2}'),
    ("&chi;", '\u{3c7}'),
    ("&circ;", '\u{2c6}'),
    ("&clubs;", '\u{2663}'),
    ("&colon;", ':'),
    ("&cong;", '\u{2245}'),
    ("&copy;", '\u{a9}'),
    ("&crarr;", '\u{21b5}'),
    ("&cup;", '\u{222a}'),
    ("&curren;", '\u{a4}'),
    ("&dArr;", '\u{21d3}'),
    ("&dagger;", '\u{2020}'),
    ("&darr;", '\u{2193}'),
    ("&deg;", '\u{b0}'),
    ("&delta;", '\u{3b4}'),
    ("&diams;", '\u{2666}'),
    ("&divide;", '\u{f7}'),
    ("&eacute;", '\u{e9}'),
    ("&ecirc;", '\u{ea}'),
    ("&egrave;", '\u{e8}'),
    ("&empty;", '\u{2205}'),
    ("&emsp;", '\u{2003}'),
    ("&ensp;", '\u{2002}'),
    ("&epsilon;", '\u{3b5}'),
    ("&equiv;", '\u{2261}'),
    ("&eta;", '\u{3b7}'),
    ("&eth;", '\u{f0}'),
    ("&euml;", '\u{eb}'),
    ("&euro;", '\u{20ac}'),
    ("&exist;", '\u{2203}'),
    ("&fnof;", '\u{192}'),
    ("&forall;", '\u{2200}'),
    ("&frac12;", '\u{bd}'),
    ("&frac14;", '\u{bc}'),
    ("&frac34;", '\u{be}'),
    ("&frasl;", '\u{2044}'),
    ("&gamma;", '\u{3b3}'),
    ("&ge;", '\u{2265}'),
    ("&gt;", '\u{3e}'),
    ("&hArr;", '\u{21d4}'),
    ("&harr;", '\u{2194}'),
    ("&hearts;", '\u{2665}'),
    ("&hellip;", '\u{2026}'),
    ("&iacute;", '\u{ed}'),
    ("&icirc;", '\u{ee}'),
    ("&iexcl;", '\u{a1}'),
    ("&igrave;", '\u{ec}'),
    ("&image;", '\u{2111}'),
    ("&infin;", '\u{221e}'),
    ("&int;", '\u{222b}'),
    ("&iota;", '\u{3b9}'),
    ("&iquest;", '\u{bf}'),
    ("&isin;", '\u{2208}'),
    ("&iuml;", '\u{ef}'),
    ("&kappa;", '\u{3ba}'),
    ("&lArr;", '\u{21d0}'),
    ("&lambda;", '\u{3bb}'),
    ("&lang;", '\u{2329}'),
    ("&laquo;", '\u{ab}'),
    ("&larr;", '\u{2190}'),
    ("&lceil;", '\u{2308}'),
    ("&ldquo;", '\u{201c}'),
    ("&le;", '\u{2264}'),
    ("&lfloor;", '\u{230a}'),
    ("&lowast;", '\u{2217}'),
    ("&loz;", '\u{25ca}'),
    ("&lrm;", '\u{200e}'),
    ("&lsaquo;", '\u{2039}'),
    ("&lsquo;", '\u{2018}'),
    ("&lt;", '\u{3c}'),
    ("&macr;", '\u{af}'),
    ("&mdash;", '\u{2014}'),
    ("&micro;", '\u{b5}'),
    ("&middot;", '\u{b7}'),
    ("&minus;", '\u{2212}'),
    ("&mu;", '\u{3bc}'),
    ("&nabla;", '\u{2207}'),
    ("&nbsp;", '\u{a0}'),
    ("&ndash;", '\u{2013}'),
    ("&ne;", '\u{2260}'),
    ("&ni;", '\u{220b}'),
    ("&not;", '\u{ac}'),
    ("&notin;", '\u{2209}'),
    ("&nsub;", '\u{2284}'),
    ("&ntilde;", '\u{f1}'),
    ("&nu;", '\u{3bd}'),
    ("&num;", '#'),
    ("&oacute;", '\u{f3}'),
    ("&ocirc;", '\u{f4}'),
    ("&oelig;", '\u{153}'),
    ("&ograve;", '\u{f2}'),
    ("&oline;", '\u{203e}'),
    ("&omega;", '\u{3c9}'),
    ("&omicron;", '\u{3bf}'),
    ("&oplus;", '\u{2295}'),
    ("&or;", '\u{2228}'),
    ("&ordf;", '\u{aa}'),
    ("&ordm;", '\u{ba}'),
    ("&oslash;", '\u{f8}'),
    ("&otilde;", '\u{f5}'),
    ("&otimes;", '\u{2297}'),
    ("&ouml;", '\u{f6}'),
    ("&para;", '\u{b6}'),
    ("&part;", '\u{2202}'),
    ("&permil;", '\u{2030}'),
    ("&perp;", '\u{22a5}'),
    ("&phi;", '\u{3c6}'),
    ("&pi;", '\u{3c0}'),
    ("&piv;", '\u{3d6}'),
    ("&plusmn;", '\u{b1}'),
    ("&pound;", '\u{a3}'),
    ("&prime;", '\u{2032}'),
    ("&prod;", '\u{220f}'),
    ("&prop;", '\u{221d}'),
    ("&psi;", '\u{3c8}'),
    ("&quot;", '\u{22}'),
    ("&rArr;", '\u{21d2}'),
    ("&radic;", '\u{221a}'),
    ("&rang;", '\u{232a}'),
    ("&raquo;", '\u{bb}'),
    ("&rarr;", '\u{2192}'),
    ("&rceil;", '\u{2309}'),
    ("&rdquo;", '\u{201d}'),
    ("&real;", '\u{211c}'),
    ("&reg;", '\u{ae}'),
    ("&rfloor;", '\u{230b}'),
    ("&rho;", '\u{3c1}'),
    ("&rlm;", '\u{200f}'),
    ("&rsaquo;", '\u{203a}'),
    ("&rsquo;", '\u{2019}'),
    ("&sbquo;", '\u{201a}'),
    ("&scaron;", '\u{161}'),
    ("&sdot;", '\u{22c5}'),
    ("&sect;", '\u{a7}'),
    ("&shy;", '\u{ad}'),
    ("&sigma;", '\u{3c3}'),
    ("&sigmaf;", '\u{3c2}'),
    ("&sim;", '\u{223c}'),
    ("&sol;", '/'),
    ("&spades;", '\u{2660}'),
    ("&sub;", '\u{2282}'),
    ("&sube;", '\u{2286}'),
    ("&sum;", '\u{2211}'),
    ("&sup;", '\u{2283}'),
    ("&sup1;", '\u{b9}'),
    ("&sup2;", '\u{b2}'),
    ("&sup3;", '\u{b3}'),
    ("&supe;", '\u{2287}'),
    ("&szlig;", '\u{df}'),
    ("&tau;", '\u{3c4}'),
    ("&there4;", '\u{2234}'),
    ("&theta;", '\u{3b8}'),
    ("&thetasym;", '\u{3d1}'),
    ("&thinsp;", '\u{2009}'),
    ("&thorn;", '\u{fe}'),
    ("&tilde;", '\u{2dc}'),
    ("&times;", '\u{d7}'),
    ("&trade;", '\u{2122}'),
    ("&uArr;", '\u{21d1}'),
    ("&uacute;", '\u{fa}'),
    ("&uarr;", '\u{2191}'),
    ("&ucirc;", '\u{fb}'),
    ("&ugrave;", '\u{f9}'),
    ("&uml;", '\u{a8}'),
    ("&upsih;", '\u{3d2}'),
    ("&upsilon;", '\u{3c5}'),
    ("&uuml;", '\u{fc}'),
    ("&weierp;", '\u{2118}'),
    ("&xi;", '\u{3be}'),
    ("&yacute;", '\u{fd}'),
    ("&yen;", '\u{a5}'),
    ("&yuml;", '\u{ff}'),
    ("&zeta;", '\u{3b6}'),
    ("&zwj;", '\u{200d}'),
    ("&zwnj;", '\u{200c}'),
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
            if tail.strip_prefix(ent).is_some() {
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
    // #172: entity decoding can put tag-shaping characters into a
    // value the source emitted unquoted; quoting only on whitespace
    // or '"' let a decoded '>' re-open markup (XSS on the engine
    // origin). Quote on any character that can break the tag open,
    // and escape angle brackets on emit.
    // #342: a decoded '&' re-emitted unquoted changes the DOM value
    // (a&amp;lt;b re-emitted bare reads back as a<b), so '&' also
    // forces quoting (the quoted branches re-escape it).
    let needs_quote = value
        .chars()
        .any(|c| c.is_ascii_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`' | '=' | '&'));
    let quote = match quote {
        Some(q) => Some(q),
        None if needs_quote => Some('"'),
        None => None,
    };
    match quote {
        Some('"') => format!(
            "{}=\"{}\"",
            name,
            value
                .replace('&', "&amp;")
                .replace('"', "&quot;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        ),
        Some('\'') => format!(
            "{}='{}'",
            name,
            value
                .replace('&', "&amp;")
                .replace('\'', "&#39;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
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
    fn location_policy_modes_caps_and_events() {
        let mut r = Rewriter::new(cfg());
        r.set_location_policy("off", 512 * 1024);
        assert_eq!(r.rewrite_js_body("location.pathname"), "location.pathname");
        assert_eq!(r.take_location_events(), "disabled");
        r.set_location_policy("hybrid", 8);
        assert_eq!(r.rewrite_js_body("location.pathname"), "location.pathname");
        assert_eq!(r.take_location_events(), "size-cap");
        r.set_location_policy("hybrid", 512 * 1024);
        assert_eq!(r.rewrite_js_body("location.pathname"), "__zl.pathname");
        assert_eq!(r.take_location_events(), "rewritten");
        assert_eq!(
            r.rewrite_js_body("const location = 1; location;"),
            "const location = 1; location;"
        );
        assert_eq!(r.take_location_events(), "no-reads");
        assert_eq!(r.rewrite_js_body("location.["), "location.[");
        assert_eq!(r.take_location_events(), "parse-failure");
        let out = r.process("<div onclick=\"location.href\"></div><script>location.href</script>");
        assert!(out.contains("onclick=\"location.href\""), "{out}");
        assert!(out.contains("<script>__zl.href</script>"), "{out}");
        for _ in 0..100 {
            r.rewrite_js_body("location.href");
        }
        assert!(r.take_location_events().split(',').count() <= 32);
    }

    #[test]
    fn script_type_ignores_other_attribute_values() {
        for (tag, executable) in [
            (
                r#"<script title="the type of data" type="application/ld+json">"#,
                false,
            ),
            (
                r#"<script data-x="a type=application/json" type="module">"#,
                true,
            ),
            (r#"<script type="application/ld+json">"#, false),
            (r#"<script type="module">"#, true),
            (
                r#"<script data-x=' type="application/json"' TYPE=module>"#,
                true,
            ),
            (r#"<script/type=module>"#, true),
            (r#"<script type type="application/json">"#, true),
            (r#"<script type="application/json" type="module">"#, false),
            (r#"<script type="text&#47;javascript">"#, true),
        ] {
            assert_eq!(script_type_is_js(tag), executable, "{tag}");
            let body = r#"const u = "https://api.example/v1";"#;
            let html = format!("{tag}{body}</script>");
            // Every split includes splits inside quotes and attribute names.
            for split in 0..=html.len() {
                let mut r = Rewriter::new(cfg());
                let out = format!(
                    "{}{}{}",
                    r.process(&html[..split]),
                    r.process(&html[split..]),
                    r.finish()
                );
                assert_eq!(out.contains(body), !executable, "split {split}: {out}");
            }
        }
    }

    #[test]
    fn script_escape_transitions_match_html_tokenizer() {
        for (body, close) in [
            ("<!-- <script> </script> </script>REST", 24),
            ("<!-- <scripts> </script>REST", 15),
            ("<!-- <SCRIPT\t> </ScRiPt > </SCRIPT>REST", 26),
            ("<!-- <script> --> <script> </script>REST", 27),
        ] {
            assert_eq!(
                find_script_close(body).map(|(start, _)| start),
                Some(close),
                "{body}"
            );
        }
        assert_eq!(find_script_close("<!-- <script> </script>REST"), None);
    }

    #[test]
    fn double_escape_end_does_not_swallow_following_markup() {
        let html = r#"<html><body><script><!--
document.write('<script src=x></script>');
</script><a href="https://other.example/p">L</a><img src="/i.png"></body></html>"#;
        for split in 0..=html.len() {
            let mut r = Rewriter::new(cfg());
            r.set_base("https://example.com/page.html");
            let out = format!(
                "{}{}{}",
                r.process(&html[..split]),
                r.process(&html[split..]),
                r.finish()
            );
            assert!(
                out.contains(&cfg().encode_url("https://other.example/p")),
                "split {split}: {out}"
            );
            assert!(
                out.contains(&cfg().encode_url("https://example.com/i.png")),
                "split {split}: {out}"
            );
            assert!(
                !out.contains("https://other.example/p"),
                "split {split}: {out}"
            );
        }
    }

    #[test]
    fn json_script_body_is_not_rewritten() {
        // #369: a data script is passed through byte-for-byte.
        let base = "https://demo.example/app.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let json = r#"{"api":"https://api.example/v1"}"#;
        let html = format!(
            r#"<html><head><script type="application/json">{}</script></head></html>"#,
            json
        );
        let out = r.process(&html);
        assert!(out.contains(json), "JSON body changed: {}", out);
    }

    #[test]
    fn uppercase_script_close_ends_the_script() {
        // #397: </SCRIPT> is a real close (the tokenizer matches the
        // marker ASCII case-insensitively); with a lowercase-only
        // match the close was missed, the next <script src> was
        // swallowed into the first raw body and its src never routed.
        let base = "https://demo.example/app.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let html = r#"<script>x</SCRIPT><script src="https://cdn.x.com/b.js"></script>"#;
        let out = r.process(html);
        let routed = cfg().encode_url("https://cdn.x.com/b.js");
        assert!(out.contains(&routed), "src not routed: {}", out);
    }

    #[test]
    fn module_script_body_still_rewritten() {
        let base = "https://demo.example/app.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let html = r#"<html><head><script type="module">const a = "https://api.example/v1";</script></head></html>"#;
        let out = r.process(html);
        assert!(
            !out.contains(r#""https://api.example/v1""#),
            "module literal not rewritten: {}",
            out
        );
    }

    #[test]
    fn turnstile_script_src_stays_provider_direct() {
        // #123: Turnstile api.js locates its own <script> tag by
        // the original src; a routed src breaks self-location and
        // the widget never injects (infinite spinner where the
        // captcha should be).
        let base = "https://demo.example/login.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let html = r#"<html><head><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script src="https://www.google.com/recaptcha/api.js"></script><iframe src="https://challenges.cloudflare.com/x"></iframe></head></html>"#;
        let out = r.process(html);
        let enc = |u: &str| {
            let abs = resolve(u, base);
            cfg().encode_url(&abs)
        };
        // The Turnstile src is untouched, provider-direct.
        assert!(
            out.contains(r#"src="https://challenges.cloudflare.com/turnstile/v0/api.js""#),
            "got: {}",
            out
        );
        // recaptcha script srcs stay routed: that path is verified
        // working (#112 co= virtualization, #120 frame redirect). The
        // filename rides as a route fragment for self-location
        // (#161 class).
        assert!(
            out.contains(&format!(
                r#"src="{}#api.js""#,
                enc("https://www.google.com/recaptcha/api.js")
            )),
            "got: {}",
            out
        );
        // Non-script tags on the challenge host still route; #120
        // handles widget frame navigations at the fetch seam.
        assert!(
            out.contains(&format!(
                r#"src="{}""#,
                enc("https://challenges.cloudflare.com/x")
            )),
            "got: {}",
            out
        );
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
    fn integrity_stripped_but_cors_and_urls_survive() {
        // SRI hashes are computed over the upstream bytes; the
        // rewritten subresource always differs, so the browser
        // silently refuses it on mismatch (issue #77). The rewriter
        // must drop integrity but keep crossorigin and the
        // rewritten src/href.
        let base = "https://example.com/page.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let full = format!(
            "{}{}{}",
            r.process(
                "<script src=\"/app.js\" integrity=\"sha384-X\" crossorigin=\"anonymous\"></script>"
            ),
            r.process(
                "<link rel=\"stylesheet\" href=\"/s.css\" integrity=\"sha384-Y\" crossorigin=\"anonymous\">"
            ),
            r.finish()
        );
        let low = full.to_ascii_lowercase();
        assert!(!low.contains("integrity"), "got: {}", full);
        assert!(low.contains("crossorigin"), "got: {}", full);
        let enc = |u: &str| {
            let abs = resolve(u, base);
            cfg().encode_url(&abs)
        };
        assert!(full.contains(&enc("/app.js")), "got: {}", full);
        assert!(full.contains(&enc("/s.css")), "got: {}", full);
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
    fn image_set_strings_in_style_blocks_and_attributes() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = r.process("<style>a{background:image-set('a.png' 1x)}</style><div style=\"background:image-set('b.png' 1x)\"></div>");
        assert!(!out.contains("'a.png'"), "got: {out}");
        assert!(!out.contains("'b.png'"), "got: {out}");
        assert!(out.matches("/j/").count() >= 2, "got: {out}");
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
    fn torture_doc_chunk_invariance() {
        // #512: one CI browser run saw the served srcset candidate
        // URL-resolve browser-direct while the served attribute
        // carried no plaintext fixture URL. The rewriter is the only
        // srcset author, so pin the deterministic contract here: the
        // SAME document must produce byte-identical output no matter
        // where the upstream stream splits it. Mirrors the e2e
        // torture fixture constructs (CRLF-in-tag, unquoted and
        // padded attributes, unicode src, srcset, iframe, relative
        // anchor, JS literals).
        let doc = concat!(
            "<!doctype html><html><head><title>zl torture</title>\n",
            "<link rel=\"stylesheet\" href=\"torture.css\">\n",
            "<style>.tl-inl{background:url(\"img.png\")}</style>\n",
            "</head><body>\n",
            "<p id=\"zl-marker\">zl-torture-page</p>\n",
            "<img id=\"crlf\"\r\n src=\"img.png\" alt=\"c\">\n",
            "<img id=\"unq\" src=img.png alt=\"u\">\n",
            "<img id=\"spaced\"    src   =   \"img.png\" alt=\"s\">\n",
            "<img id=\"uni\" src=\"unicode/\u{e5}.png\" alt=\"n\">\n",
            "<img id=\"ss\" srcset=\"img.png 1x, img.png 2x\" alt=\"x\">\n",
            "<iframe id=\"fru\" src=\"inner.html\"></iframe>\n",
            "<a id=\"relimg\" href=\"./img.png\">m</a>\n",
            "<script>\n",
            "var im2 = new Image(); im2.id = \"tlit\"; im2.src = \"/dir/img.png\"; document.body.appendChild(im2);\n",
            "</script>\n",
            "</body></html>"
        );
        let base = "http://127.0.0.1:7101/dir/torture.html";
        let run = |chunks: &[&str]| -> String {
            let mut r = Rewriter::new(cfg());
            r.set_base(base);
            let mut out = String::new();
            for c in chunks {
                out.push_str(&r.process(c));
            }
            out.push_str(&r.finish());
            out
        };
        let reference = run(&[doc]);
        let chars: Vec<char> = doc.chars().collect();
        for k in 1..chars.len() {
            let a: String = chars[..k].iter().collect();
            let b: String = chars[k..].iter().collect();
            let out = run(&[&a, &b]);
            if out != reference {
                let pos = out
                    .bytes()
                    .zip(reference.bytes())
                    .position(|(x, y)| x != y)
                    .unwrap_or(out.len());
                let w = |s: &str| {
                    String::from_utf8_lossy(
                        &s.as_bytes()[pos.saturating_sub(30)..(pos + 30).min(s.len())],
                    )
                    .into_owned()
                };
                panic!(
                    "#512: split at char {} diverges at byte {}: got {:?} want {:?}",
                    k,
                    pos,
                    w(&out),
                    w(&reference)
                );
            }
        }
        // The finest legal stream: one char per chunk.
        let singles: Vec<String> = chars.iter().map(|c| c.to_string()).collect();
        let refs: Vec<&str> = singles.iter().map(|s| s.as_str()).collect();
        let out = run(&refs);
        assert_eq!(
            out, reference,
            "#512: single-char streaming diverges from the whole-document pass"
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

    /// Lazy images: opt-in injection of loading=\"lazy\" on <img>.
    #[test]
    fn lazy_images_opt_in() {
        // Off by default: nothing is invented.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!("{}{}", r.process("<img src=\"x.png\">"), r.finish());
        assert!(!out.contains("loading"), "off by default: {}", out);
        // On: a missing loading attribute is injected exactly once; an
        // explicit author choice is kept; non-img tags untouched.
        let mut r = Rewriter::new(cfg());
        r.set_lazy_images();
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<img src=\"x.png\"><img src=\"y.png\" loading=\"eager\"><div class=\"loading\">d</div>"),
            r.finish()
        );
        assert!(out.contains(" loading=\"lazy\""), "injected: {}", out);
        assert_eq!(
            out.matches("loading=\"").count(),
            2,
            "one added, one kept: {}",
            out
        );
        assert!(
            out.contains("loading=\"eager\""),
            "author choice kept: {}",
            out
        );
        assert!(
            out.contains("class=\"loading\""),
            "non-img untouched: {}",
            out
        );
    }

    #[test]
    fn lazy_images_chunked_and_bare_forms() {
        // A bare loading attribute (no value) counts as present.
        let bare = {
            let mut r = Rewriter::new(cfg());
            r.set_lazy_images();
            r.set_base("https://example.com/");
            format!("{}{}", r.process("<img loading src=\"x.png\">"), r.finish())
        };
        assert!(!bare.contains("lazy"), "bare loading counts: {}", bare);
        // The tag split mid-attribute across chunks still injects once.
        let chunked = {
            let mut r = Rewriter::new(cfg());
            r.set_lazy_images();
            r.set_base("https://example.com/");
            let a = r.process("<img src=\"x");
            let b = r.process(".png\">");
            format!("{}{}{}", a, b, r.finish())
        };
        assert!(
            chunked.contains(" loading=\"lazy\""),
            "chunked injection: {}",
            chunked
        );
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
        // Known entities decode; unknown or malformed references
        // pass through untouched.
        assert_eq!(decode_entities("&nbsp;&unknown;&#"), "\u{a0}&unknown;&#");
    }

    #[test]
    fn decodes_html4_named_entities() {
        // The full HTML4 table: whatever spelling the source used, the
        // DOM sees the decoded character, so the rewriter must too.
        assert_eq!(decode_entities("&nbsp;"), "\u{a0}");
        assert_eq!(decode_entities("&copy;&deg;&euro;"), "\u{a9}\u{b0}\u{20ac}");
        // Named and numeric forms of the same character agree.
        assert_eq!(decode_entities("&copy;"), decode_entities("&#169;"));
        // Unknown references still pass through untouched.
        assert_eq!(decode_entities("&notanentity;"), "&notanentity;");
    }

    #[test]
    fn full_table_keeps_pass_through_values_stable() {
        // A pass-through value must stay DOM-stable across repeated
        // rewrite passes: decode once at the attribute seam, emit
        // format_attr's re-escaped form, decode again - same value.
        // Entities never stack (no &amp;nbsp; chains) no matter
        // which HTML4 spelling the source used.
        let src = "a&nbsp;b &copy; c &amp; d &#38; e";
        let once = decode_entities(src);
        let emitted = format_attr("title", &once, Some('"'));
        let value = emitted
            .split("title=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or_default();
        assert_eq!(decode_entities(value), once);
        assert_eq!(once, "a\u{a0}b \u{a9} c & d & e");
    }

    #[test]
    fn engine_origin_prefix_requires_a_boundary() {
        // Bug-scout fix: the engine-origin check was a bare
        // starts_with, so a same-suffix host
        // (https://proxy.example.evil.com for the origin
        // https://proxy.example) passed as engine-local and escaped
        // rewriting entirely. The byte after the origin must be a
        // URL boundary: end of URL, '/', '?' or '#'.
        let c = RewriteConfig {
            origin: "https://proxy.example".into(),
            codec: Codec::Base64Url {
                prefix: "/zl/".into(),
            },
            ..cfg()
        };
        let mut r = Rewriter::new(c);
        r.set_base("https://target.com/");
        assert_eq!(r.enc("https://proxy.example"), "https://proxy.example");
        assert_eq!(
            r.enc("https://proxy.example/zl/abc"),
            "https://proxy.example/zl/abc"
        );
        assert_eq!(
            r.enc("https://proxy.example?q=1"),
            "https://proxy.example?q=1"
        );
        let out = r.enc("https://proxy.example.evil.com/x");
        assert_ne!(out, "https://proxy.example.evil.com/x");
        let expected = format!(
            "https://proxy.example/zl/{}",
            crate::encode::b64u_encode(b"https://proxy.example.evil.com/x")
        );
        assert_eq!(out, expected, "rewritten to a route: {}", out);
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

    /// Decode the route out of the first `name="..."`/`name='...'`
    /// attribute value in `out` and return the destination URL it
    /// encodes.
    fn decoded_attr(out: &str, name: &str) -> String {
        for q in ['"', '\''] {
            let needle = format!("{}={}", name, q);
            if let Some(seg) = out.split(&needle).nth(1) {
                let raw = seg.split(q).next().unwrap_or("");
                let route = raw.trim_end_matches(['\'', '"']);
                return route
                    .rsplit('/')
                    .next()
                    .and_then(crate::encode::b64u_decode)
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default();
            }
        }
        String::new()
    }

    #[test]
    fn meta_csp_tags_dropped_report_only_too() {
        // Bug-scout issue 3: header CSP is stripped (HOSTILE list)
        // because rewritten subresources ride engine-origin routes
        // the original directives never allow; a meta CSP must not
        // survive either. The whole tag goes; unrelated meta tags
        // (charset, content-type http-equiv) stay untouched.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/page.html");
        let full = format!(
            "{}{}",
            r.process(
                "<head><meta http-equiv='Content-Security-Policy' content='script-src https://cdn.x.com'><meta http-equiv='content-security-policy-report-only' content='default-src self'><meta charset='utf-8'><meta http-equiv='content-type' content='text/html; charset=utf-8'></head>",
            ),
            r.finish()
        );
        let low = full.to_ascii_lowercase();
        assert!(!low.contains("content-security"), "got: {}", full);
        assert!(full.contains("charset"), "got: {}", full);
        assert!(full.contains("content-type"), "got: {}", full);
    }

    #[test]
    fn meta_refresh_content_url_rewritten() {
        // Issue #36: the refresh target is a navigation - without the
        // rewrite the meta refresh escapes the engine entirely.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page.html");
        let out = format!(
            "{}{}",
            r.process("<meta http-equiv=\"refresh\" content=\"5; url=next.html\">"),
            r.finish()
        );
        assert_eq!(
            decoded_attr(&out, "content"),
            "https://example.com/dir/next.html",
            "got: {}",
            out
        );
        assert!(out.contains("5; url="), "delay preserved: {}", out);
    }

    #[test]
    fn meta_refresh_shapes() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page.html");
        // Quoted target, either quote char; quoted absolute URL.
        let out = format!(
            "{}{}",
            r.process("<meta http-equiv=\"refresh\" content=\"0; url='top.html'\">"),
            r.finish()
        );
        assert_eq!(
            decoded_attr(&out, "content"),
            "https://example.com/dir/top.html",
            "got: {}",
            out
        );
        // Plain delay: no url= part, nothing to rewrite.
        let out = format!(
            "{}{}",
            r.process("<meta http-equiv=\"refresh\" content=\"5\">"),
            r.finish()
        );
        assert!(out.contains("content=\"5\""), "got: {}", out);
        // http-equiv (not refresh) content stays untouched.
        let out = format!(
            "{}{}",
            r.process("<meta http-equiv=\"content-type\" content=\"5; url=x.html\">"),
            r.finish()
        );
        assert!(out.contains("content=\"5; url=x.html\""), "got: {}", out);
        // Attribute order: content BEFORE http-equiv still rewrites.
        let out = format!(
            "{}{}",
            r.process("<meta content=\"2;url=up.html\" http-equiv=\"REFRESH\">"),
            r.finish()
        );
        assert_eq!(
            decoded_attr(&out, "content"),
            "https://example.com/dir/up.html",
            "got: {}",
            out
        );
    }

    #[test]
    fn meta_refresh_survives_chunk_boundaries() {
        // The tag is split mid-content-value: the tokenizer must hold
        // the incomplete tag and rewrite once it completes.
        let one_shot = {
            let mut r = Rewriter::new(cfg());
            r.set_base("https://example.com/dir/page.html");
            format!(
                "{}{}",
                r.process("<meta http-equiv=\"refresh\" content=\"5; url=next.html\">tail"),
                r.finish()
            )
        };
        let chunked = {
            let mut r = Rewriter::new(cfg());
            r.set_base("https://example.com/dir/page.html");
            let a = r.process("<meta http-equiv=\"ref");
            let b = r.process("resh\" content=\"5; url=ne");
            let c = r.process("xt.html\">tail");
            format!("{}{}{}{}", a, b, c, r.finish())
        };
        assert_eq!(chunked, one_shot);
    }

    #[test]
    fn iframe_srcdoc_rewritten_as_nested_document() {
        // Issue #36: srcdoc is a full HTML document in an attribute;
        // its URLs must be routed like any other markup.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page.html");
        let out = format!(
            "{}{}",
            r.process("<iframe srcdoc=\"<p><img src='x.png'></p>\"></iframe>"),
            r.finish()
        );
        let srcdoc_val = out
            .split("srcdoc=\"")
            .nth(1)
            .and_then(|s| s.split("\">").next())
            .unwrap_or_default();
        // format_attr re-escaped the nested quotes as &quot;: decode
        // the attribute value back to its DOM form before searching.
        assert_eq!(
            decoded_attr(&decode_entities(srcdoc_val), "src"),
            "https://example.com/dir/x.png",
            "got: {}",
            out
        );
    }

    #[test]
    fn iframe_srcdoc_entity_roundtrip_is_dom_stable() {
        // The srcdoc value arrives entity-decoded; after the nested
        // rewrite the emitted value must decode back to the same DOM
        // value (byte shape may differ, the document must not).
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<iframe srcdoc=\"&lt;p&gt;hi &amp; bye&lt;/p&gt;\"></iframe>"),
            r.finish()
        );
        let srcdoc_val = out
            .split("srcdoc=\"")
            .nth(1)
            .and_then(|s| s.split("\">").next())
            .unwrap_or_default();
        assert_eq!(
            decode_entities(srcdoc_val),
            decode_entities("&lt;p&gt;hi &amp; bye&lt;/p&gt;"),
            "got: {}",
            out
        );
        assert_eq!(decode_entities(srcdoc_val), "<p>hi & bye</p>");
    }

    #[test]
    fn base_href_switches_the_folding_base() {
        // Issue #36: after <base href>, relative URLs fold against
        // the base, not the document URL. The base href itself is
        // rewritten, and only the first base counts.
        let base = "https://example.com/dir/page.html";
        let enc = |u: &str| cfg().encode_url(&resolve(u, "https://cdn.example.com/assets/"));
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = format!(
            "{}{}",
            r.process(
                "<head><base href=\"https://cdn.example.com/assets/\"><base href=\"https://ignored.example.com/\"></head><img src=\"x.png\">"
            ),
            r.finish()
        );
        assert!(
            out.contains(&format!(
                "href=\"{}\"",
                enc("https://cdn.example.com/assets/")
            )),
            "base href rewritten: {}",
            out
        );
        assert!(
            out.contains(&format!("src=\"{}\"", enc("x.png"))),
            "x.png folds against the base: {}",
            out
        );
        // Only the FIRST base folds: if the second one had won, x.png
        // would have been encoded against ignored.example.com instead.
    }

    #[test]
    fn base_href_folds_across_chunk_boundaries() {
        // The base tag arrives in chunk 1, the img in chunk 2: the
        // folding base must survive the boundary.
        let one_shot = {
            let mut r = Rewriter::new(cfg());
            r.set_base("https://example.com/dir/page.html");
            format!(
                "{}{}",
                r.process("<base href=\"https://cdn.example.com/assets/\"><img src=\"x.png\">"),
                r.finish()
            )
        };
        let chunked = {
            let mut r = Rewriter::new(cfg());
            r.set_base("https://example.com/dir/page.html");
            let a = r.process("<base href=\"https://cdn.example.com/as");
            let b = r.process("sets/\"><img src=\"x.png\">");
            format!("{}{}{}", a, b, r.finish())
        };
        assert_eq!(chunked, one_shot);
    }

    #[test]
    fn base_href_fragment_and_empty_ignored() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page.html");
        let out = format!(
            "{}{}",
            r.process("<base href=\"#frag\"><base href=\"\"><img src=\"x.png\">"),
            r.finish()
        );
        assert_eq!(
            decoded_attr(&out, "src"),
            "https://example.com/dir/x.png",
            "folding base unchanged: {}",
            out
        );
    }

    #[test]
    fn svg_paint_attributes_routed() {
        // Issue #36: SVG presentation attributes carry url() paint
        // references; fragment-only references stay client-side.
        let base = "https://example.com/app/page.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = format!(
            "{}{}",
            r.process(
                "<svg><path fill=\"url(#grad)\"><path fill=\"url(sprites.svg#icon)\"><path filter=\"url(https://cdn.example.net/f.svg#f)\"><path fill=\"url(#a) #333\"></svg>"
            ),
            r.finish()
        );
        assert!(out.contains("fill=\"url(#grad)\""), "got: {}", out);
        assert!(out.contains("fill=\"url(#a) #333\""), "got: {}", out);
        assert!(
            out.contains(&format!(
                "fill=\"url('{}#icon')\"",
                cfg().encode_url("https://example.com/app/sprites.svg")
            )),
            "sprite reference routed: {}",
            out
        );
        assert!(
            out.contains(&format!(
                "filter=\"url('{}#f')\"",
                cfg().encode_url("https://cdn.example.net/f.svg")
            )),
            "external filter routed: {}",
            out
        );
    }

    #[test]
    fn ping_attribute_urls_routed() {
        let base = "https://example.com/a.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = format!(
            "{}{}",
            r.process("<a href=\"next.html\" ping=\"/px1 https://other.example/px2\">x</a>"),
            r.finish()
        );
        let ping = out
            .split("ping=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or_default();
        let urls: Vec<String> = ping
            .split_whitespace()
            .map(|route| {
                route
                    .rsplit('/')
                    .next()
                    .and_then(crate::encode::b64u_decode)
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default()
            })
            .collect();
        assert_eq!(
            urls,
            vec![
                "https://example.com/px1".to_string(),
                "https://other.example/px2".to_string()
            ],
            "got: {}",
            out
        );
    }

    #[test]
    fn opaque_urls_pass_through_unwrapped() {
        // Issue #36: data:, blob:, about:, javascript: and other
        // opaque URLs are client-side payloads the engine cannot
        // fetch; they must survive unwrapped, commas and all.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process(
                "<img src=\"data:image/png;base64,iVBORw0KGgoAAA,foo\"><iframe src=\"about:blank\"></iframe><a href=\"javascript:void(0)\">j</a><a href=\"mailto:a@b.c\">m</a>"
            ),
            r.finish()
        );
        assert!(
            out.contains("src=\"data:image/png;base64,iVBORw0KGgoAAA,foo\""),
            "got: {}",
            out
        );
        assert!(out.contains("src=\"about:blank\""), "got: {}", out);
        assert!(out.contains("href=\"javascript:void(0)\""), "got: {}", out);
        assert!(out.contains("href=\"mailto:a@b.c\""), "got: {}", out);
    }

    #[test]
    fn srcset_data_url_intact() {
        // Issue #36: srcset with a data URL candidate - the naive
        // comma split destroyed both candidates; the WHATWG parser
        // keeps the data URL (commas included) and still routes the
        // normal one.
        let base = "https://example.com/dir/page.html";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = format!(
            "{}{}",
            r.process("<img srcset=\"data:image/png;base64,iVBORw0KGgoAAA 1x, b.png 2x\">"),
            r.finish()
        );
        assert!(
            out.contains("data:image/png;base64,iVBORw0KGgoAAA 1x"),
            "data URL candidate intact: {}",
            out
        );
        assert!(out.contains(" 2x"), "descriptor kept: {}", out);
        let routed = cfg().encode_url("https://example.com/dir/b.png");
        assert!(out.contains(&routed), "b.png routed: {}", out);
    }

    #[test]
    fn rewrites_external_script_body() {
        // #46: the SW serve seam runs the same URL-literal +
        // frame-buster pipeline on external script bodies that inline
        // <script> content gets from the Raw state.
        let base = "https://cdn.example.com/lib/app.js";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = r.rewrite_js_body(
            r#"if (top != self) top.location = "https://example.com/"; el.src = "https://img.example.net/a.png"; var s = "hello";"#,
        );
        assert!(out.contains("if (self != self)"), "folded guard: {}", out);
        assert!(!out.contains("top.location"), "navigation sunk: {}", out);
        assert!(
            out.contains("self.zl_antiframe"),
            "sunk to antiframe prop: {}",
            out
        );
        let enc = |u: &str| {
            let abs = resolve(u, base);
            cfg().encode_url(&abs)
        };
        assert!(
            out.contains(&format!(r#""{}""#, enc("https://img.example.net/a.png"))),
            "literal URL routed: {}",
            out
        );
        assert!(
            out.contains(r#""hello""#),
            "non-URL literal intact: {}",
            out
        );
    }

    /// #126: inline module scripts resolve import specifiers against
    /// the document's engine route, which the SW cannot recover at
    /// fetch time. The rewriter routes non-bare specifiers itself.
    #[test]
    fn js_body_module_specifiers_route() {
        let base = "https://cdn.example.com/lib/app.js";
        let mut r = Rewriter::new(cfg());
        r.set_base(base);
        let out = r.rewrite_js_body(
            "import './mod.js'; import('https://cdn.example.com/other.js'); import 'lodash';",
        );
        let enc = |u: &str| {
            let abs = resolve(u, base);
            cfg().encode_url(&abs)
        };
        assert!(
            out.contains(&format!("'{}'", enc("./mod.js"))),
            "relative specifier routed: {}",
            out
        );
        assert!(
            out.contains(&format!("'{}'", enc("https://cdn.example.com/other.js"))),
            "dynamic specifier routed: {}",
            out
        );
        assert!(out.contains("'lodash'"), "bare specifier intact: {}", out);
    }

    /// #126: a specifier that is already an engine route must not
    /// gain a second wrap when a rewritten body is rewritten again
    /// (the double-wrap hazard, issue #1 finding 4).
    #[test]
    fn js_body_routed_specifier_stays_single() {
        let base = "https://cdn.example.com/lib/app.js";
        let c = cfg();
        let mut r0 = Rewriter::new(c.clone());
        r0.set_base(base);
        let once = r0.rewrite_js_body("import './mod.js';");
        let route = once.trim_start_matches("import '").trim_end_matches("';");
        assert!(
            !route.contains("import"),
            "route extraction failed: {}",
            once
        );
        let mut r = Rewriter::new(c.clone());
        r.set_base(base);
        let twice = r.rewrite_js_body(&format!("import '{}';", route));
        assert_eq!(twice, once, "second pass must re-emit one route, not wrap");
    }

    /// #112: a JS literal whose destination path ends in "/" keeps
    /// the last path segment visible after the keyed token, so
    /// runtime tail checks (reCAPTCHA enterprise appends "api2/"
    /// unless its api base ends with "enterprise/") still hold, and
    /// the appended suffix lands on recoverPath, which decodes
    /// token(parent) + "/seg/..." back to parent + "/seg/...".
    #[test]
    fn js_literal_directory_keeps_last_segment_visible() {
        let mut c = cfg();
        c.codec = Codec::Keyed {
            prefix: "/j/".into(),
            key: core::array::from_fn(|i| i as u8),
        };
        let base = "https://www.google.com/sorry/index";
        let mut r = Rewriter::new(c.clone());
        r.set_base(base);
        let js = "var api='https://www.google.com/recaptcha/enterprise/';var page='https://www.google.com/';var file='https://www.google.com/x.js';";
        let out = r.rewrite_js_body(js);
        // Directory literal: token(parent) + "/enterprise/".
        let parent = c.encode_url("https://www.google.com/recaptcha");
        let dir_route = parent + "/enterprise/";
        assert!(
            out.contains(&format!("'{}'", dir_route)),
            "directory literal split: {}",
            out
        );
        // Not the single token for the whole directory.
        assert!(
            !out.contains(&c.encode_url("https://www.google.com/recaptcha/enterprise/")),
            "whole-directory token absent: {}",
            out
        );
        // Root-only and file literals keep the plain single-token form.
        assert!(
            out.contains(&format!("'{}'", c.encode_url("https://www.google.com/"))),
            "root-only literal unchanged: {}",
            out
        );
        assert!(
            out.contains(&format!(
                "'{}'",
                c.encode_url("https://www.google.com/x.js")
            )),
            "file literal unchanged: {}",
            out
        );
    }

    #[test]
    fn external_script_body_routes_pass_through() {
        // #46: the specifier pass runs first at the seam, so the body
        // can already contain root-relative engine routes. A decodable
        // route unwraps and re-emits as exactly one route (never
        // double-wrapped); a token that does not decode to an
        // http(s) destination is an honest page-relative path and
        // routes like any other. An engine-origin absolute route
        // stays engine-local.
        let base = "https://cdn.example.com/lib/app.js";
        let origin = "https://engine.example.org";
        let mut c = cfg();
        c.origin = origin.to_string();
        let token = c.encode_url("https://keep.example/ok");
        let mut r = Rewriter::new(c);
        r.set_base(base);
        let out = r.rewrite_js_body(&format!(
            "import({token:?}); fetch(\"https://engine.example.org/j/d29ybGQ\");"
        ));
        assert!(
            out.contains(&format!("{token:?}")),
            "decodable route stays single: {}",
            out
        );
        assert!(
            out.contains(r#"fetch("https://engine.example.org/j/d29ybGQ")"#),
            "engine-origin URL stays local: {}",
            out
        );
    }

    #[test]
    fn vite_mapdeps_relative_assets_route_against_module_base() {
        // #131: Vite's __vite__mapDeps dependency map is a plain
        // string array of dot-relative asset paths. The runtime
        // resolves them against the module URL before any fetch, so
        // they must encode against the SCRIPT's base here - not the
        // document's - or every chunk lands on an engine-origin path
        // no referrer recovery can resolve correctly.
        let base = "https://cdn.example.com/serp/_app/immutable/entry/app.js";
        let mut c = cfg();
        c.origin = "https://engine.example.org".to_string();
        let mut r = Rewriter::new(c.clone());
        r.set_base(base);
        let js = r#"m.f=["../chunks/aB12.js","../nodes/0.Cd.js","../assets/app.css"];"#;
        let out = r.rewrite_js_body(js);
        for (dep, abs) in [
            (
                "../chunks/aB12.js",
                "https://cdn.example.com/serp/_app/immutable/chunks/aB12.js",
            ),
            (
                "../nodes/0.Cd.js",
                "https://cdn.example.com/serp/_app/immutable/nodes/0.Cd.js",
            ),
            (
                "../assets/app.css",
                "https://cdn.example.com/serp/_app/immutable/assets/app.css",
            ),
        ] {
            assert!(
                out.contains(&format!("{}{}{}", '"', c.encode_url(abs), '"')),
                "dep {} routed: {}",
                dep,
                out
            );
            assert!(!out.contains(dep), "raw dep {} gone: {}", dep, out);
        }
        // Idempotent: a second pass over the routed output keeps
        // every route single-wrapped.
        let mut r2 = Rewriter::new(c);
        r2.set_base(base);
        let twice = r2.rewrite_js_body(&out);
        assert_eq!(twice, out);
    }

    /// #161 class: pages locate their CMP stub <script> by substring
    /// on the ORIGINAL src ("script[src*='otBannerSdk.js']"). An
    /// opaque route breaks the lookup and the CMP crashes on a null
    /// tag. The destination's last path segment rides as a fragment
    /// on the route: substring matching works again and the fetch
    /// target is unchanged (fragments are stripped before the
    /// request; the route token never encodes them).
    #[test]
    fn script_src_keeps_filename_fragment_for_self_location() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://site.example/dir/page.html");
        let out = format!(
            "{}{}",
            r.process("<script src=\"https://cdn.cmp.example/sdk/otBannerSdk.js\"></script>"),
            r.finish()
        );
        let route = cfg().encode_url("https://cdn.cmp.example/sdk/otBannerSdk.js");
        assert!(
            out.contains(&format!("src=\"{}#otBannerSdk.js\"", route)),
            "filename rides as a route fragment: {}",
            out
        );
        // The route token itself is unchanged: strip the fragment and
        // decode - the bare destination.
        let val = out
            .split("src=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or_default();
        let decoded = val
            .split('#')
            .next()
            .and_then(|tok| tok.rsplit('/').next())
            .and_then(crate::encode::b64u_decode)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        assert_eq!(decoded, "https://cdn.cmp.example/sdk/otBannerSdk.js");
    }

    fn keyed_cfg() -> RewriteConfig {
        let mut c = cfg();
        c.codec = Codec::Keyed {
            prefix: "/zl/".into(),
            key: core::array::from_fn(|i| i as u8),
        };
        c
    }

    /// #296-class (YouTube ytembeds "base-js"): pages validate their
    /// own loader script by the SHAPE of its src path (the ytembeds
    /// bootstrap requires "/_/js/" and "/k=" in the path before it
    /// defines writeEmbed; Google basejs builds chunk URLs by surgery
    /// on the src path). Under the keyed codec the script src mint
    /// keeps the real path and query visible after an origin-only
    /// token, which the SW decodes via recoverPath exactly like the
    /// #112 split literals.
    #[test]
    fn keyed_script_src_mints_path_preserving_route() {
        let c = keyed_cfg();
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://www.youtube.com/embed/aqz-KE-bpKQ");
        let html = "<script src=\"https://www.youtube.com/s/_/ytembeds/_/js/k=ytembeds.base.en_US.x.2021.O/am=A/d=1/rs=R/m=root,base?cb=42\" id=\"base-js\"></script>";
        let out = format!("{}{}", r.process(html), r.finish());
        let token = crate::encode::b64u_encode(&crate::encode::keyed_token(
            &core::array::from_fn(|i| i as u8),
            b"https://www.youtube.com",
        ));
        let expected = format!(
            "/zl/{}{}",
            token,
            "/s/_/ytembeds/_/js/k=ytembeds.base.en_US.x.2021.O/am=A/d=1/rs=R/m=root,base?cb=42"
        );
        assert!(
            out.contains(&expected),
            "origin-only token + visible path/query: {}",
            out
        );
    }

    /// Legacy codec: the script mint falls back to the opaque route,
    /// same as every other attribute (recoverPath refuses legacy
    /// split tails).
    #[test]
    fn legacy_script_src_keeps_opaque_route() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://site.example/page.html");
        let out = format!(
            "{}{}",
            r.process("<script src=\"https://cdn.example/sdk/app.js\"></script>"),
            r.finish()
        );
        let route = cfg().encode_url("https://cdn.example/sdk/app.js");
        assert!(
            out.contains(&format!("src=\"{}#app.js\"", route)),
            "legacy stays opaque + fragment: {}",
            out
        );
    }

    /// A path past the recoverPath cap keeps the opaque route: a
    /// split tail the SW would refuse is never minted.
    #[test]
    fn keyed_script_src_long_path_keeps_opaque_route() {
        let c = keyed_cfg();
        let long_seg = "a".repeat(2100);
        let src = format!("https://cdn.example/{}/x.js", long_seg);
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://site.example/");
        let out = format!(
            "{}{}",
            r.process(&format!("<script src=\"{}\"></script>", src)),
            r.finish()
        );
        let opaque = c.encode_url(&src);
        assert!(
            out.contains(&opaque),
            "long path falls back to the opaque route: {}",
            out
        );
        assert!(
            !out.contains(&long_seg),
            "no visible tail beyond the recoverPath cap: {}",
            out
        );
    }

    /// A src that already carries a fragment keeps its own fragment
    /// on the split form; the #161 filename fragment is not doubled.
    #[test]
    fn keyed_script_src_with_own_fragment_keeps_it() {
        let c = keyed_cfg();
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://site.example/");
        let out = format!(
            "{}{}",
            r.process("<script src=\"https://cdn.example/b.js#own\"></script>"),
            r.finish()
        );
        assert!(
            out.contains("/b.js#own"),
            "visible path and own fragment: {}",
            out
        );
        assert!(!out.contains("#own#"), "no doubled fragment: {}", out);
    }

    #[test]
    fn script_src_fragment_shapes() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://site.example/page.html");
        let out = format!(
            "{}{}",
            r.process(
                "<script src=\"https://cdn.example/a.js?v=2\"></script><script src=\"https://cdn.example/b.js#own\"></script><script src=\"https://cdn.example/\"></script><a href=\"https://cdn.example/c.js\">x</a><img src=\"https://cdn.example/d.png\">"
            ),
            r.finish()
        );
        // Query is stripped from the filename fragment.
        let qa = cfg().encode_url("https://cdn.example/a.js?v=2");
        assert!(
            out.contains(&format!("src=\"{}#a.js\"", qa)),
            "query stripped from the fragment: {}",
            out
        );
        // A src that already carries a fragment keeps its own.
        let qb = cfg().encode_url("https://cdn.example/b.js");
        assert!(
            out.contains(&format!("src=\"{}#own\"", qb)),
            "own fragment kept, no second one: {}",
            out
        );
        // Root-only path: no filename to expose, no fragment.
        let qc = cfg().encode_url("https://cdn.example/");
        assert!(
            out.contains(&format!("src=\"{}\"", qc)),
            "root-only src untouched: {}",
            out
        );
        // Anchors and images gain no fragment: their fragments (if
        // any) carry real client-side semantics.
        assert!(
            !out.contains("#c.js"),
            "anchor href gains no fragment: {}",
            out
        );
        assert!(
            !out.contains("#d.png"),
            "img src gains no fragment: {}",
            out
        );
    }

    /// #554: an inline import map routes its target URLs through the
    /// engine so mapped modules stop escaping browser-direct. The
    /// bare key keeps its specifier text; the value becomes the same
    /// opaque keyed route a rewritten module specifier carries; a
    /// scope prefix key takes the path-preserving split form so
    /// prefix matching still sees the path; invalid JSON stays
    /// verbatim for the native error.
    #[test]
    fn importmap_script_routes_through_the_engine() {
        let c = keyed_cfg();
        let mut r = Rewriter::new(c.clone());
        r.set_base("https://site.example/dir/page.html");
        let html = "<script type=\"importmap\">{\"imports\":{\"lodash\":\"https://cdn.example/l.js\"},\"scopes\":{\"https://site.example/app/\":{\"widget\":\"https://cdn.example/w.js\"}}}</script>";
        let out = format!("{}{}", r.process(html), r.finish());
        assert!(
            out.contains(&format!(
                "\"lodash\":\"{}\"",
                c.encode_url("https://cdn.example/l.js")
            )),
            "bare key intact, value routed: {}",
            out
        );
        let token = crate::encode::b64u_encode(&crate::encode::keyed_token(
            &core::array::from_fn(|i| i as u8),
            b"https://site.example",
        ));
        let split_scope = format!("/zl/{}/app/", token);
        assert!(
            out.contains(&split_scope),
            "scope prefix key rides the split form: {}",
            out
        );
        assert!(
            out.contains(&format!(
                "\"widget\":\"{}\"",
                c.encode_url("https://cdn.example/w.js")
            )),
            "scope value routed: {}",
            out
        );
    }

    /// #554: an unparseable map passes through unchanged: the
    /// browser raises exactly its native error.
    #[test]
    fn importmap_invalid_json_stays_verbatim() {
        let mut r = Rewriter::new(cfg());
        r.set_base("https://site.example/");
        let html = "<script type=\"importmap\">{not json at all</script>";
        let out = format!("{}{}", r.process(html), r.finish());
        assert!(out.contains("{not json at all"), "verbatim: {}", out);
    }

    /// #172: values that entity-decode to tag-shaping characters
    /// are re-emitted quoted and escaped, never in a shape where a
    /// decoded '>' opens real markup.
    #[test]
    fn format_attr_quotes_values_that_need_it() {
        assert_eq!(format_attr("title", "plain", None), "title=plain");
        assert_eq!(format_attr("title", "a=b", None), "title=\"a=b\"");
        assert_eq!(format_attr("title", "a`b", None), "title=\"a`b\"");
        assert_eq!(format_attr("title", "a<b", None), "title=\"a&lt;b\"");
        // An explicit quote style is preserved.
        assert_eq!(format_attr("title", "a<b", Some('\'')), "title='a&lt;b'");
    }

    #[test]
    fn entity_decoded_gt_cannot_break_out_of_attrs() {
        // #172: the browser reads 'title=x&gt;<img...' as one span
        // whose title decodes to "x><img..."; the rewrite must keep
        // it one tag instead of re-emitting a raw '>' that opens the
        // img as real, script-bearing markup.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<span title=x&gt;<img src=x onerror=alert(1)>>hi</span>"),
            r.finish()
        );
        assert!(
            out.contains("title=\"x&gt;&lt;img\""),
            "quoted and escaped: {}",
            out
        );
        assert!(!out.contains("title=x"), "unquoted again: {}", out);
        assert!(!out.contains("<img src=x"), "breakout: {}", out);
    }

    #[test]
    fn unquoted_entity_value_round_trips() {
        // #342: title=a&amp;lt;b must re-emit so the DOM value stays
        // "a&lt;b"; the bare unquoted re-emit turned it into "a<b".
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<p title=a&amp;lt;b>x</p><img src=\"https://t.example/i.png\">"),
            r.finish()
        );
        assert!(
            out.contains("title=\"a&amp;lt;b\""),
            "quoted and escaped re-emit: {}",
            out
        );
        assert!(
            out.contains(&cfg().encode_url("https://t.example/i.png")),
            "later markup rewritten: {}",
            out
        );
    }

    #[test]
    fn apostrophe_in_unquoted_attr_does_not_eat_document() {
        // #175: a quote opens a value only right after '='; the
        // apostrophe in an unquoted value must not start a quote hunt
        // that swallows the rest of the document.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<p class=it's>hi</p><img src=\"https://t.example/i.png\">"),
            r.finish()
        );
        assert!(out.contains("class=\"it's\""), "quoted re-emit: {}", out);
        assert!(out.contains("hi</p>"), "closed at '>': {}", out);
        assert!(
            out.contains(&cfg().encode_url("https://t.example/i.png")),
            "later markup rewritten: {}",
            out
        );
    }

    #[test]
    fn slash_separated_attributes_still_rewrite() {
        // #173: a lone '/' between attributes is a separator, not
        // part of the name.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}{}",
            r.process("<img/src=\"https://t.example/x.gif\">"),
            r.process("<a/href=\"https://t.example/p\">x</a>"),
            r.finish()
        );
        assert!(
            out.contains(&cfg().encode_url("https://t.example/x.gif")),
            "img src rewritten: {}",
            out
        );
        assert!(
            out.contains(&cfg().encode_url("https://t.example/p")),
            "a href rewritten: {}",
            out
        );
    }

    #[test]
    fn comment_ends_at_incorrect_close_form() {
        // #174: HTML ends comments at "--!>" as well; the rewriter
        // must not sleep until the next "-->".
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<!-- x --!><img src=\"https://t.example/p.gif\"><!-- y -->"),
            r.finish()
        );
        assert!(
            out.contains(&cfg().encode_url("https://t.example/p.gif")),
            "img after --!> rewritten: {}",
            out
        );
        assert!(out.contains("--!>"), "marker kept: {}", out);
    }

    #[test]
    fn multibyte_comment_tail_does_not_panic() {
        // #177: the retained comment tail must cut on a char
        // boundary; a multibyte character straddling the cut used to
        // panic the wasm call.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("<!-- €");
        let b = r.process(" mid");
        let c = r.process("dle --> tail");
        let out = format!("{}{}{}", a, b, c);
        assert_eq!(out, "<!-- € middle --> tail");
    }

    #[test]
    fn split_script_tag_still_rewrites_body() {
        // #187: the element name comes from the completed tag, so a
        // tag split across chunks still classifies as script.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("<scr");
        let b = r.process("ipt>var u='https://t.example/x';</script>");
        let out = format!("{}{}", a, b);
        assert!(
            out.contains(&cfg().encode_url("https://t.example/x")),
            "script body literal rewritten: {}",
            out
        );
    }

    #[test]
    fn split_head_tag_injects_bootstrap_before_scripts() {
        // #187: "<he" + "ad>" recognizes the completed head; the
        // bootstrap lands right after it, not at finish() after the
        // page's scripts.
        let mut r = Rewriter::new(RewriteConfig::default());
        r.set_base("https://example.com/");
        let a = r.process("<he");
        let b = r.process("ad><script>var s=1;</script>");
        let out = format!("{}{}", a, b);
        let bi = out.find("bootstrap.js").unwrap();
        let si = out.find("var s=1").unwrap();
        assert!(bi < si, "bootstrap before page scripts: {}", out);
    }

    #[test]
    fn close_tag_prefix_in_string_does_not_end_script() {
        // #188: the raw block ends at a TERMINATED close tag; the
        // string "</scripts" inside a script body never ends it.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process("<script>var s=\"</scripts\";var u='https://t.example/x';</script>"),
            r.finish()
        );
        assert!(
            out.contains(&cfg().encode_url("https://t.example/x")),
            "literal after the string rewritten: {}",
            out
        );
        assert!(out.contains("</scripts"), "string intact: {}", out);
    }

    #[test]
    fn double_escaped_script_closes_at_the_real_end() {
        // #339: per the HTML tokenizer, "<!--" plus a nested
        // "<script" enters the double-escaped state, where an inner
        // "</script>" does NOT close the element. The old close
        // search ended raw there, so everything after it was parsed
        // as markup: URL literals unrewritten, antiframe skipped.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process(
                "<script><!--\ndocument.write('<script>a</script>');\nvar u = \"https://cdn.x.com/a.js\";\nif (top.location != self.location) top.location = location;\n//--></script><img src=\"https://t.example/z.gif\">"
            ),
            r.finish()
        );
        assert!(
            out.contains(&cfg().encode_url("https://cdn.x.com/a.js")),
            "literal after the double-escaped close rewritten: {}",
            out
        );
        assert!(out.contains("document.write"), "body intact: {}", out);
        // The close used must be the OUTER one: the img after the
        // real close tag is rewritten as markup, not swallowed.
        assert!(
            out.contains(&cfg().encode_url("https://t.example/z.gif")),
            "markup after the real close rewritten: {}",
            out
        );
    }

    #[test]
    fn escaped_comment_script_still_closes_normally() {
        // #339 control: "<!--" WITHOUT a nested "<script" never
        // enters double-escaped, so a later "</script>" still
        // closes (escaped state closes on the close tag).
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let out = format!(
            "{}{}",
            r.process(
                "<script><!-- guard\nvar u = \"https://cdn.x.com/a.js\";\n//--></script><img src=\"https://t.example/z.gif\">"
            ),
            r.finish()
        );
        assert!(
            out.contains(&cfg().encode_url("https://cdn.x.com/a.js")),
            "literal inside the escaped block rewritten: {}",
            out
        );
        assert!(
            out.contains(&cfg().encode_url("https://t.example/z.gif")),
            "markup after the close rewritten: {}",
            out
        );
    }

    #[test]
    fn partial_comment_open_waits_for_more_input() {
        // #190: a partial "<!" / "<!-" waits for input instead of
        // being classified as a doctype, which would leave the rest
        // of the comment unrewritten.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let a = r.process("<!");
        let b = r.process("-- a > <script> never closed -->");
        let c = r.process("<img src=\"https://t.example/z.gif\">");
        let out = format!("{}{}{}", a, b, c);
        assert!(
            out.contains(&cfg().encode_url("https://t.example/z.gif")),
            "img after the comment rewritten: {}",
            out
        );
    }

    #[test]
    fn rcdata_rawtext_content_not_rewritten_as_markup() {
        // #207: RCDATA (textarea, title) and RAWTEXT (noembed, xmp,
        // iframe) content is visible text; rewriting it corrupts
        // what the user sees.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let html = r#"<textarea><a href="https://t.example/p">x</a></textarea><noembed><a href="https://t.example/n">z</a></noembed><xmp><a href="https://t.example/x">w</a></xmp>"#;
        let out = format!("{}{}", r.process(html), r.finish());
        assert_eq!(out, html, "raw text verbatim");
    }

    #[test]
    fn html5_colon_entity_decodes_in_urls() {
        // #205: HTML5-only named entities decode in attribute values
        // (&colon;, &num;, &sol;): the browser hands the DOM the
        // decoded text, so matching and encoding must agree.
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/dir/page.html");
        let a = format!(
            "{}{}",
            r.process("<a href=\"https&colon;//t.example/a\">c</a>"),
            r.finish()
        );
        assert_eq!(decoded_attr(&a, "href"), "https://t.example/a", "{}", a);
        let b = format!(
            "{}{}",
            r.process("<a href=\"/x&num;frag\">n</a>"),
            r.finish()
        );
        assert!(b.contains("#frag"), "fragment client-side: {}", b);
        assert!(
            b.contains(&cfg().encode_url("https://example.com/x")),
            "{}",
            b
        );
        let c = format!("{}{}", r.process("<a href=\"/y&sol;z\">s</a>"), r.finish());
        assert!(
            c.contains(&cfg().encode_url("https://example.com/y/z")),
            "{}",
            c
        );
    }

    #[test]
    fn blocked_raw_swallows_close_tagless_body_bounded() {
        // #322: a blocked element with no close tag must not pin the
        // whole rest of the response in memory while swallowing it.
        let c = RewriteConfig {
            block_hosts: vec!["ads.example.net".into()],
            ..cfg()
        };
        let mut r = Rewriter::new(c);
        r.set_base("https://example.com/");
        let mut out = r.process("<script src=\"https://cdn.ads.example.net/x.js\">");
        out.push_str(&r.process(&"x".repeat(DROP_RAW_CAP * 4)));
        assert!(
            r.buf.len() <= 4096,
            "swallow buffer bounded without a close tag: {}",
            r.buf.len()
        );
        out.push_str(&r.process("</script>after"));
        out.push_str(&r.finish());
        assert!(!out.contains("ads.example.net"), "blocked: {}", out);
        assert!(out.contains("after"), "post-close text survives: {}", out);
    }

    #[test]
    fn normal_raw_block_stays_untrimmed() {
        // #322 guards only the blocked path: a legit large script still
        // buffers whole until its close tag (browser raw-text parity).
        let mut r = Rewriter::new(cfg());
        r.set_base("https://example.com/");
        let big = "var x = 1;".repeat(60000);
        let _ = r.process("<script>");
        let _ = r.process(&big);
        assert!(
            r.buf.len() >= big.len(),
            "normal raw buffer untouched: {}",
            r.buf.len()
        );
        let mut out = r.process("</script>done");
        out.push_str(&r.finish());
        assert!(out.contains("var x = 1;"), "script body survives");
        assert!(out.contains("done"));
    }
    #[test]
    fn userinfo_url_literals_stay_verbatim() {
        // #499: a Sentry DSN is URL-shaped configuration parsed by
        // application JS as written; an engine route fails the DSN
        // parse. The literal must keep its verbatim value while a
        // browser-owned fetch URL in the same bundle still routes.
        let r = Rewriter::new(cfg());
        let dsn = "https://abc123@o456.ingest.sentry.io/42";
        let js = format!(
            "Sentry.init({{ dsn: '{}' }}); fetch('https://www.example.com/api');",
            dsn
        );
        let out = r.rewrite_js_body(&js);
        assert!(out.contains(dsn), "DSN literal must stay verbatim: {out}");
        let route = format!(
            "/j/{}",
            crate::encode::b64u_encode(b"https://www.example.com/api")
        );
        assert!(
            out.contains(&route),
            "browser-owned fetch URL must still route: {out}"
        );
    }
    #[test]
    fn userinfo_gate_is_authority_only() {
        let r = Rewriter::new(cfg());
        // An @ in the query is not userinfo: the literal still routes.
        let out = r.rewrite_js_body("fetch('https://www.example.com/mail?to=a@b.com')");
        let route = format!(
            "/j/{}",
            crate::encode::b64u_encode(b"https://www.example.com/mail?to=a@b.com")
        );
        assert!(out.contains(&route), "query @ must not gate: {out}");
        // The inline handler path uses the same literal gate.
        let mut r2 = Rewriter::new(cfg());
        let html = r#"<a onclick="send('https://key@host.example/42')">u</a>"#;
        let out2 = r2.process(html);
        assert!(
            out2.contains("https://key@host.example/42"),
            "inline handler literal keeps verbatim value: {out2}"
        );
    }
    #[test]
    fn userinfo_html_attributes_still_route() {
        // Browser-owned sinks (href) are not gated: only JS string
        // literals (enc_literal) take the #499 verbatim branch.
        let mut r = Rewriter::new(cfg());
        let out = r.process(r#"<a href="https://user:pw@example.com/x">u</a>"#);
        let route = format!(
            "/j/{}",
            crate::encode::b64u_encode(b"https://user:pw@example.com/x")
        );
        assert!(out.contains(&route), "href routing must not change: {out}");
    }
}
