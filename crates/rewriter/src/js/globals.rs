//! #235/#236: virtual-location renames for pathname-routed SPAs.
//!
//! SvelteKit-class client routers match their route tables against
//! location.pathname, which the engine has replaced with the opaque
//! route, so every pathname-routed SPA falls back to a full document
//! load and loses its client-minted state (Brave Ask, the wave-25
//! README Working-sites entry). window.location is
//! [LegacyUnforgeable]: no bootstrap hook can make the page see the
//! real path, the fix has to change the code that reads location
//! (#39's documented limit). This pass parses script bodies with oxc
//! (the same engine-class approach Scramjet takes) and renames
//! location READS to the bootstrap's virtual location global
//! (#236, app/src/bootstrap/vloc.ts):
//!
//! - bare 'location' in read position, scope-resolved (a shadowed
//!   local is never renamed) -> __zl
//! - <window|self|globalThis|document|top|parent>.location reads
//!   -> __zl; the bracket form with a string literal key
//!   (window['location']) renames too (#331); a computed
//!   non-literal (window[x]) is unknowable at rewrite time and
//!   stays native
//! - document.URL / document.documentURI reads (receiver
//!   'document' only; window.URL is the URL constructor) ->
//!   __zl.href (#238): SvelteKit's start() compares document.URL
//!   with location.href and self-assigns on mismatch (kit PR
//!   11179); against the opaque route the compare never passes
//!   and the self-assign reload-storms the document.
//!
//! Deliberate v1 limits (kept honest in README Working sites):
//! - writes stay native ('location = x', 'window.location = x'):
//!   the proxy cannot receive them and the navguard's navigate
//!   seam already owns that navigation class.
//! - bare top/parent stay native: frame-buster comparisons must
//!   keep native window identity.
//! - eval/new Function source is NOT rewritten (a documented
//!   limit, same as the reference engine).
//! - shorthand { location } stays native: renaming the value
//!   would change the key. Destructuring FROM the receiver
//!   (const { location } = window) stays native for the same
//!   reason: the pattern key is a binding name, not a reference.
//! - scripts over MAX_BYTES or without the location or URL tokens skip
//!   the parse entirely; a parse failure falls back to the
//!   unrenamed body (never broken JS) and is counted for
//!   diagnostics.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};

use oxc_allocator::Allocator;
use oxc_ast::ast::Expression;
use oxc_ast::ast_kind::AstKind;
use oxc_ast_visit::Visit;
use oxc_parser::Parser;
use oxc_semantic::{ReferenceFlags, Semantic, SemanticBuilder};
use oxc_span::{SourceType, Span};

/// The bootstrap's virtual location global (#236). Short on
/// purpose: renamed minified bundles carry one occurrence per read.
pub const VLOC: &str = "__zl";

/// document.URL/documentURI reads rename to the virtual href,
/// not the virtual location object: they are string reflections
/// of the page URL (#238).
const DOC_URL: &str = "__zl.href";

/// Receivers whose .location read is the page location.
const RECEIVERS: [&str; 6] = ["window", "self", "globalThis", "document", "top", "parent"];

/// Scripts above this size skip the AST pass: parse cost grows with
/// size and the huge-heap case gains nothing a router needs.
/// ponytail: raise only when a live site needs it.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

static PARSED: AtomicU32 = AtomicU32::new(0);
static FAILED: AtomicU32 = AtomicU32::new(0);
static RENAMED: AtomicU32 = AtomicU32::new(0);

/// Cumulative counters ("parsed,failed,renamed") for the SW's diag
/// seam (wasm.rs globalsStats). Monotonic for the SW lifetime.
pub fn stats_string() -> String {
    format!(
        "{},{},{}",
        PARSED.load(Ordering::Relaxed),
        FAILED.load(Ordering::Relaxed),
        RENAMED.load(Ordering::Relaxed)
    )
}

/// Rename location reads in a script body to the virtual location
/// global. Parse failures and oversized bodies return the input
/// unchanged: broken JS is worse than a missed rewrite, and the
/// runtime paths still own the residual class.
pub fn rewrite_globals(js: &str) -> String {
    // Fast path: nothing to rename without the tokens. The document
    // URL reflection reaches the DOC_URL arm through the static form
    // (document.URL) and the #331 bracket form (document["URL"]);
    // a bare URL token is too common (new URL(), url.searchParams),
    // so the bracket check requires the document token too.
    if js.len() > MAX_BYTES
        || !(js.contains("location")
            || js.contains("documentURI")
            || (js.contains("document") && js.contains("URL")))
    {
        return js.to_string();
    }
    let Some(edits) = collect(js) else {
        FAILED.fetch_add(1, Ordering::Relaxed);
        return js.to_string();
    };
    if edits.is_empty() {
        return js.to_string();
    }
    PARSED.fetch_add(1, Ordering::Relaxed);
    RENAMED.fetch_add(edits.len() as u32, Ordering::Relaxed);
    let mut out = String::with_capacity(js.len() + edits.len() * (VLOC.len() + 5));
    let mut pos = 0usize;
    for (start, end, repl) in &edits {
        out.push_str(&js[pos..*start]);
        out.push_str(repl);
        pos = *end;
    }
    out.push_str(&js[pos..]);
    out
}

/// Parse and collect the (start, end) byte spans to replace, or None
/// when the body does not parse as module or script.
fn collect(js: &str) -> Option<Vec<(usize, usize, &'static str)>> {
    let allocator = Allocator::default();
    let module = SourceType::default().with_module(true);
    let ret = Parser::new(&allocator, js, module).parse();
    let program = if ret.diagnostics.is_empty() {
        ret.program
    } else {
        // Script-only syntax (with statements) fails the module
        // parse; retry as script before giving up.
        let script = Parser::new(&allocator, js, SourceType::default()).parse();
        if script.diagnostics.is_empty() {
            script.program
        } else {
            return None;
        }
    };
    let built = SemanticBuilder::new().build(&program);
    let semantic = built.semantic;
    let mut w = Walker {
        sem: &semantic,
        src: js,
        shorthand: HashSet::new(),
        edits: Vec::new(),
    };
    w.visit_program(&program);
    w.edits.sort_by_key(|(s, _, _)| *s);
    Some(w.edits)
}

struct Walker<'a, 's> {
    sem: &'s Semantic<'a>,
    src: &'s str,
    /// Shorthand property values ({ location }): renaming the value
    /// would change the key, so their spans are excluded.
    shorthand: HashSet<Span>,
    edits: Vec<(usize, usize, &'static str)>,
}

impl<'a, 's> Visit<'a> for Walker<'a, 's> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            AstKind::ObjectProperty(p) => {
                if p.shorthand {
                    if let Expression::Identifier(id) = &p.value {
                        self.shorthand.insert(id.span);
                    }
                }
            }
            AstKind::IdentifierReference(id) => {
                if id.name.as_str() == "location" && !self.shorthand.contains(&id.span) {
                    let Some(rid) = id.reference_id.get() else {
                        return;
                    };
                    let reference = self.sem.scoping().get_reference(rid);
                    let flags = reference.flags();
                    if reference.symbol_id().is_none()
                        && flags.contains(ReferenceFlags::Read)
                        && !flags.contains(ReferenceFlags::Write)
                    {
                        self.edits
                            .push((id.span.start as usize, id.span.end as usize, VLOC));
                    }
                }
            }
            AstKind::StaticMemberExpression(m) if m.property.name.as_str() == "location" => {
                if let Expression::Identifier(obj) = &m.object {
                    if RECEIVERS.contains(&obj.name.as_str())
                        && obj.reference_id.get().is_some_and(|rid| {
                            self.sem.scoping().get_reference(rid).symbol_id().is_none()
                        })
                        && !self.is_write_target(m.span)
                        && !self.is_delete_target(m.span)
                    {
                        self.edits
                            .push((m.span.start as usize, m.span.end as usize, VLOC));
                    }
                }
            }
            // #238: document.URL/documentURI are read-only
            // reflections of the document's URL. SvelteKit's
            // start() compares document.URL with location.href
            // and self-assigns location.href to resync (kit PR
            // 11179, basic-auth drop): against the opaque native
            // route the compare never passes and the self-assign
            // reload-storms the document (the Brave SERP 429
            // wall). Both sides must see the same virtual URL.
            // Only 'document' carries the reflection;
            // window.URL is the URL constructor.
            AstKind::StaticMemberExpression(m)
                if matches!(m.property.name.as_str(), "URL" | "documentURI")
                    && !self.is_write_target(m.span)
                    && !self.is_delete_target(m.span) =>
            {
                if let Expression::Identifier(obj) = &m.object {
                    if obj.name.as_str() == "document"
                        && obj.reference_id.get().is_some_and(|rid| {
                            self.sem.scoping().get_reference(rid).symbol_id().is_none()
                        })
                    {
                        self.edits
                            .push((m.span.start as usize, m.span.end as usize, DOC_URL));
                    }
                }
            }
            // #331: a computed property read with a STRING LITERAL
            // key carries the same meaning as the static form;
            // minified and obfuscated bundles reach for brackets.
            // Only literal keys rename. A computed non-literal
            // (window[x]) is unknowable at rewrite time and stays
            // native. The write/delete tail peeks are the same ones
            // the static form runs, so assignments and deletes keep
            // their native receiver.
            AstKind::ComputedMemberExpression(m) => {
                if let Expression::StringLiteral(lit) = &m.expression {
                    match lit.value.as_str() {
                        "location" => {
                            if let Expression::Identifier(obj) = &m.object {
                                if RECEIVERS.contains(&obj.name.as_str())
                                    && obj.reference_id.get().is_some_and(|rid| {
                                        self.sem.scoping().get_reference(rid).symbol_id().is_none()
                                    })
                                    && !self.is_write_target(m.span)
                                    && !self.is_delete_target(m.span)
                                {
                                    self.edits.push((
                                        m.span.start as usize,
                                        m.span.end as usize,
                                        VLOC,
                                    ));
                                }
                            }
                        }
                        "URL" | "documentURI" => {
                            if let Expression::Identifier(obj) = &m.object {
                                if obj.name.as_str() == "document"
                                    && obj.reference_id.get().is_some_and(|rid| {
                                        self.sem.scoping().get_reference(rid).symbol_id().is_none()
                                    })
                                    && !self.is_write_target(m.span)
                                    && !self.is_delete_target(m.span)
                                {
                                    self.edits.push((
                                        m.span.start as usize,
                                        m.span.end as usize,
                                        DOC_URL,
                                    ));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

impl Walker<'_, '_> {
    /// Is the member expression the direct target of an assignment
    /// or update? A textual peek past the span is exact for the
    /// operator set: comparison operators (==, ===, !=, !==, >=,
    /// <=) never match the assignment list, and a following '.' or
    /// '[' is a deeper property chain, not a write to this member.
    fn is_write_target(&self, span: Span) -> bool {
        const OPS: [&[u8]; 16] = [
            b"=", b"+=", b"-=", b"*=", b"/=", b"%=", b"**=", b"<<=", b">>=", b">>>=", b"&=", b"|=",
            b"^=", b"&&=", b"||=", b"??=",
        ];
        let b = self.src.as_bytes();
        let mut i = span.end as usize;
        loop {
            match b.get(i) {
                Some(b' ') | Some(0x09) | Some(0x0a) | Some(0x0d) => i += 1,
                /* #240: a comment between the member and the
                operator hides the write from a whitespace-only
                peek. A parsed body has no unterminated comment;
                an unclosed one falls back to "write", the safe
                direction that keeps the member native. */
                Some(b'/') if b.get(i + 1) == Some(&b'*') => {
                    match b[i + 2..]
                        .windows(2)
                        .position(|w| w[0] == b'*' && w[1] == b'/')
                    {
                        Some(k) => i += k + 4,
                        None => return true,
                    }
                }
                Some(b'/') if b.get(i + 1) == Some(&b'/') => {
                    match b[i + 2..].iter().position(|c| *c == b'\n') {
                        Some(k) => i += k + 2,
                        None => return true,
                    }
                }
                _ => break,
            }
        }
        // Postfix ++/--: an update target.
        if matches!(b.get(i), Some(b'+') | Some(b'-')) && b.get(i) == b.get(i + 1) {
            return true;
        }
        let run = &b[i..(i + 4).min(b.len())];
        // A trailing "=" extends no assignment op: "==" and "==="
        // are comparisons, never writes.
        OPS.iter()
            .any(|op| run.starts_with(op) && run.get(op.len()) != Some(&b'='))
    }

    /// delete <member>: the rename would produce a delete of the
    /// global binding, not the property. Rare, cheap to exclude.
    fn is_delete_target(&self, span: Span) -> bool {
        let head = &self.src[..span.start as usize];
        let trimmed = head.trim_end();
        match trimmed.len().checked_sub(6) {
            None => false,
            // i points AT the "delete" run: the word boundary is the
            // byte BEFORE it, and a head that IS the word deletes too.
            Some(i) => {
                /* #242: a property-access tail (.delete) is not
                the keyword; only a real boundary before the
                word deletes. */
                trimmed.ends_with("delete")
                    && (i == 0
                        || (!is_ident_byte(trimmed.as_bytes()[i - 1])
                            && trimmed.as_bytes()[i - 1] != b'.'))
            }
        }
    }
}

fn is_ident_byte(b: u8) -> bool {
    b == b'_' || b == b'$' || b.is_ascii_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rw(js: &str) -> String {
        rewrite_globals(js)
    }

    #[test]
    fn bare_reads_rename() {
        assert_eq!(
            rw("const p = location.pathname;"),
            "const p = __zl.pathname;"
        );
        assert_eq!(rw("var h = location.hash;"), "var h = __zl.hash;");
    }

    #[test]
    fn receiver_members_rename() {
        for obj in ["window", "self", "globalThis", "document", "top", "parent"] {
            let js = format!("var p = {obj}.location.pathname;");
            assert_eq!(rw(&js), "var p = __zl.pathname;", "{js}");
        }
        // A deeper chain keeps the tail: the inner member is the read.
        assert_eq!(
            rw("var o = window.location.origin;"),
            "var o = __zl.origin;"
        );
    }

    #[test]
    fn shadowed_locals_stay_native() {
        let js = "function f(location) { return location.pathname; }";
        assert_eq!(rw(js), js);
        let js2 = "var location = 1; location.pathname;";
        assert_eq!(rw(js2), js2);
    }

    #[test]
    fn writes_stay_native() {
        assert_eq!(rw("location = '/x';"), "location = '/x';");
        assert_eq!(rw("window.location = '/x';"), "window.location = '/x';");
        // The read half renames: the proxy stringifies to the
        // engine-anchored href, so the frame buster stays in-engine.
        assert_eq!(rw("top.location = self.location;"), "top.location = __zl;");
        // A property chain on the read half of the assignment still
        // renames the read: the proxy receives the href set.
        assert_eq!(rw("location.href = '/x';"), "__zl.href = '/x';");
    }

    #[test]
    fn comment_gap_before_assignment_stays_native() {
        // #240: the write peek must skip comments.
        assert_eq!(
            rw("window.location /* c */ = '/x';"),
            "window.location /* c */ = '/x';"
        );
        assert_eq!(
            rw("window.location // c\n= '/x';"),
            "window.location // c\n= '/x';"
        );
        // a comment after the member does not block a real read.
        assert_eq!(
            rw("var p = window.location /* c */.pathname;"),
            "var p = __zl /* c */.pathname;"
        );
    }

    #[test]
    fn property_delete_tail_is_not_the_keyword() {
        // #242: ".delete" is a property access, not the operator.
        assert_eq!(rw("o.delete\nwindow.location.href"), "o.delete\n__zl.href");
    }

    #[test]
    fn document_url_reflection_renames() {
        // #238: both sides of SvelteKit's resync compare must see
        // the virtual URL, or start() re-navigates every load.
        assert_eq!(
            rw("document.URL!==location.href&&(location.href=location.href);"),
            "__zl.href!==__zl.href&&(__zl.href=__zl.href);"
        );
        assert_eq!(rw("var u = document.URL;"), "var u = __zl.href;");
        assert_eq!(rw("var u = document.documentURI;"), "var u = __zl.href;");
        // a deeper chain keeps the tail.
        assert_eq!(
            rw("document.URL.startsWith('x');"),
            "__zl.href.startsWith('x');"
        );
    }

    #[test]
    fn document_url_writes_and_shadows_stay_native() {
        // read-only reflection: a rename would turn a browser
        // no-op write into a navigation through the href setter.
        assert_eq!(rw("document.URL = '/x';"), "document.URL = '/x';");
        assert_eq!(rw("delete document.URL;"), "delete document.URL;");
        assert_eq!(rw("document.URL++;"), "document.URL++;");
        // window.URL / globalThis.URL are the URL constructor.
        assert_eq!(rw("var U = window.URL;"), "var U = window.URL;");
        assert_eq!(rw("var U = globalThis.URL;"), "var U = globalThis.URL;");
        // a shadowed local document is not the global.
        let js = "function f(document) { return document.URL; }";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn comparisons_are_not_writes() {
        assert_eq!(
            rw("if (window.location == null) x();"),
            "if (__zl == null) x();"
        );
        assert_eq!(rw("a = location !== b;"), "a = __zl !== b;");
    }

    #[test]
    fn delete_stays_native() {
        assert_eq!(rw("delete window.location;"), "delete window.location;");
    }

    #[test]
    fn update_targets_stay_native() {
        // location++ is nonsense but must not become __zl++.
        let js = "location++; window.location++;";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn other_receivers_stay_native() {
        // a non-receiver object keeps its own location property.
        let js = "var p = x.location.pathname;";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn computed_non_literal_stays_native() {
        // #331: a computed key that is not a string literal is
        // unknowable at rewrite time.
        let js = "var q = window[key]; var r = window[0];";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn computed_string_literal_renames() {
        // #331: bracket reads with a literal key carry the same
        // meaning as the static form.
        assert_eq!(rw("var q = window['location'];"), "var q = __zl;");
        assert_eq!(rw("var q = window[\"location\"];"), "var q = __zl;");
        assert_eq!(rw("var q = globalThis['location'];"), "var q = __zl;");
        assert_eq!(rw("var u = document['URL'];"), "var u = __zl.href;");
        assert_eq!(rw("var u = document['documentURI'];"), "var u = __zl.href;");
        // writes and deletes keep the native receiver.
        assert_eq!(
            rw("window['location'] = '/x';"),
            "window['location'] = '/x';"
        );
        assert_eq!(
            rw("delete window['location'];"),
            "delete window['location'];"
        );
        // a shadowed local document is not the global.
        let js = "function f(document) { return document['URL']; }";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn optional_chaining_renames() {
        // #331: chains reach the same arms; the replaced span keeps
        // the rest of the chain intact.
        assert_eq!(rw("var p = window?.location;"), "var p = __zl;");
        assert_eq!(rw("var p = location?.pathname;"), "var p = __zl?.pathname;");
        assert_eq!(rw("var p = window?.location?.href;"), "var p = __zl?.href;");
    }

    #[test]
    fn destructuring_nested_and_calls_rename() {
        // #331: the initializer read renames; the pattern keys
        // are bindings and never change.
        assert_eq!(
            rw("const { pathname } = location;"),
            "const { pathname } = __zl;"
        );
        assert_eq!(
            rw("var n = location.pathname.substring(0, 1);"),
            "var n = __zl.pathname.substring(0, 1);"
        );
        assert_eq!(
            rw("var s = location.toString();"),
            "var s = __zl.toString();"
        );
        // destructuring FROM the receiver is the shorthand limit:
        // the pattern key is a binding name, not a reference.
        assert_eq!(
            rw("const { location } = window;"),
            "const { location } = window;"
        );
    }

    #[test]
    fn shorthand_stays_native() {
        let js = "var o = { location }; var o2 = { location, b: 1 };";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn template_substitutions_rename() {
        let tick = char::from_u32(0x60).unwrap();
        let mut js = String::from("var t = ");
        js.push(tick);
        js.push_str("a $");
        js.push_str("{location.hash} b");
        js.push(tick);
        js.push(';');
        let want = js.replace("location.hash", "__zl.hash");
        assert_eq!(rw(&js), want);
    }

    #[test]
    fn script_only_syntax_parses() {
        // with-statements fail the module parse; the script retry
        // covers them and the bare read still renames.
        assert_eq!(
            rw("with (o) { var p = location.pathname; }"),
            "with (o) { var p = __zl.pathname; }"
        );
    }

    #[test]
    fn parse_failures_fall_back_unchanged() {
        let js = "var x = ; location.pathname";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn no_location_token_is_untouched() {
        let js = "var a = 1; var b = a + 2;";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn comments_and_strings_do_not_rename() {
        let js = "var s = 'location.pathname'; // location.href";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn regex_bodies_do_not_rename() {
        let js = "var re = /location.pathname/;";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn eval_stays_native() {
        // Documented v1 limit: eval source is not rewritten.
        let js = "eval('location.pathname');";
        assert_eq!(rw(js), js);
    }

    #[test]
    fn receivers_shadowed_stay_native() {
        // A local 'window' variable: the member is not the page
        // location, and the scope-resolved check keeps it native.
        let js = "function w(window) { return window.location.pathname; }";
        assert_eq!(rw(js), js);
    }
}
