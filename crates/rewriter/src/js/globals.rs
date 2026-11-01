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
use oxc_ast::ast::{Expression, SimpleAssignmentTarget, UnaryExpression};
use oxc_ast::ast_kind::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::{ReferenceFlags, Semantic, SemanticBuilder};
use oxc_span::{GetSpan, SourceType, Span};

/// The bootstrap's virtual location global (#236). Short on
/// purpose: renamed minified bundles carry one occurrence per read.
pub const VLOC: &str = "__zl";

/// document.URL/documentURI reads rename to the virtual href,
/// not the virtual location object: they are string reflections
/// of the page URL (#238).
const DOC_URL: &str = "__zl.href";
/// #532: document.baseURI renames read the virtual base view.
const DOC_BASE: &str = "__zl.baseURI";

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
    rewrite_with_reason(js, MAX_BYTES).0
}

pub fn rewrite_with_reason(js: &str, cap: usize) -> (String, &'static str) {
    // Fast path: nothing to rename without the tokens. The document
    // URL reflection reaches the DOC_URL arm through the static form
    // (document.URL) and the #331 bracket form (document["URL"]);
    // a bare URL token is too common (new URL(), url.searchParams),
    // so the bracket check requires the document token too.
    if js.len() > cap.min(MAX_BYTES) {
        return (js.to_string(), "size-cap");
    }
    if !(js.contains("location")
        || js.contains("documentURI")
        || js.contains("baseURI")
        || (js.contains("document") && js.contains("URL")))
    {
        return (js.to_string(), "no-candidate");
    }
    let Some(edits) = collect(js) else {
        FAILED.fetch_add(1, Ordering::Relaxed);
        return (js.to_string(), "parse-failure");
    };
    if edits.is_empty() {
        return (js.to_string(), "no-reads");
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
    (out, "rewritten")
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
        native_targets: HashSet::new(),
        shorthand: HashSet::new(),
        edits: Vec::new(),
    };
    w.visit_program(&program);
    w.edits.sort_by_key(|(s, _, _)| *s);
    Some(w.edits)
}

struct Walker<'a, 's> {
    sem: &'s Semantic<'a>,
    /// Direct assignment/update/delete targets must retain their native receiver.
    native_targets: HashSet<Span>,
    /// Shorthand property values ({ location }): renaming the value
    /// would change the key, so their spans are excluded.
    shorthand: HashSet<Span>,
    edits: Vec<(usize, usize, &'static str)>,
}

impl<'a, 's> Visit<'a> for Walker<'a, 's> {
    fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
        self.native_targets.insert(it.span());
        walk::walk_simple_assignment_target(self, it);
    }

    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        if it.operator.as_str() == "delete" {
            self.native_targets
                .insert(it.argument.get_inner_expression().span());
        }
        walk::walk_unary_expression(self, it);
    }

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
                if id.name.as_str() == "location"
                    && !self.shorthand.contains(&id.span)
                    && !self.native_targets.contains(&id.span)
                {
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
                        && !self.native_targets.contains(&m.span)
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
                    && !self.native_targets.contains(&m.span) =>
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
            // #532: document.baseURI is the frozen base URL
            // reflection (HTML standard, first <base href> with a
            // non-empty href wins). Same read-only rename class as
            // document.URL: writes, deletes and update targets stay
            // native via native_targets, and a shadowed local
            // document binding never renames.
            AstKind::StaticMemberExpression(m)
                if m.property.name.as_str() == "baseURI"
                    && !self.native_targets.contains(&m.span) =>
            {
                if let Expression::Identifier(obj) = &m.object {
                    if obj.name.as_str() == "document"
                        && obj.reference_id.get().is_some_and(|rid| {
                            self.sem.scoping().get_reference(rid).symbol_id().is_none()
                        })
                    {
                        self.edits
                            .push((m.span.start as usize, m.span.end as usize, DOC_BASE));
                    }
                }
            }
            // #331: a computed property read with a STRING LITERAL
            // key carries the same meaning as the static form;
            // minified and obfuscated bundles reach for brackets.
            // Only literal keys rename. A computed non-literal
            // (window[x]) is unknowable at rewrite time and stays
            // native. AST target spans exclude writes and deletes
            // while retaining reads nested inside computed targets.
            AstKind::ComputedMemberExpression(m) => {
                if let Expression::StringLiteral(lit) = &m.expression {
                    match lit.value.as_str() {
                        "location" => {
                            if let Expression::Identifier(obj) = &m.object {
                                if RECEIVERS.contains(&obj.name.as_str())
                                    && obj.reference_id.get().is_some_and(|rid| {
                                        self.sem.scoping().get_reference(rid).symbol_id().is_none()
                                    })
                                    && !self.native_targets.contains(&m.span)
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
                                    && !self.native_targets.contains(&m.span)
                                {
                                    self.edits.push((
                                        m.span.start as usize,
                                        m.span.end as usize,
                                        DOC_URL,
                                    ));
                                }
                            }
                        }
                        "baseURI" => {
                            if let Expression::Identifier(obj) = &m.object {
                                if obj.name.as_str() == "document"
                                    && obj.reference_id.get().is_some_and(|rid| {
                                        self.sem.scoping().get_reference(rid).symbol_id().is_none()
                                    })
                                    && !self.native_targets.contains(&m.span)
                                {
                                    self.edits.push((
                                        m.span.start as usize,
                                        m.span.end as usize,
                                        DOC_BASE,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rw(js: &str) -> String {
        rewrite_globals(js)
    }

    #[test]
    fn ast_targets_stay_native_through_comments_and_parentheses() {
        for js in [
            "++window.location;",
            "[window.location] = xs;",
            "for (window.location of xs) {}",
            "window.location\u{a0}= next;",
            "--document.URL;",
            "++window['location'];",
            "delete /* gap */ window.location;",
            "delete (window.location);",
            "delete ((document['URL']));",
            "(window.location) = next;",
            "window.location /* gap */ += next;",
            "delete /* gap */ location;",
        ] {
            assert_eq!(rw(js), js, "{js}");
        }
    }

    #[test]
    fn reads_inside_assignment_and_delete_targets_still_rewrite() {
        assert_eq!(rw("window[location.href] = x;"), "window[__zl.href] = x;");
        assert_eq!(
            rw("delete window[location.href];"),
            "delete window[__zl.href];"
        );
        assert_eq!(rw("++window.location.href;"), "++__zl.href;");
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
    fn member_writes_rename_to_the_view() {
        // #182: the object of a member write is a read, so the
        // hash/search/pathname writes reach the vloc setters.
        assert_eq!(rw("location.hash = '#x';"), "__zl.hash = '#x';");
        assert_eq!(rw("location.search = '?q=1';"), "__zl.search = '?q=1';");
        assert_eq!(rw("location.pathname = '/y';"), "__zl.pathname = '/y';");
        assert_eq!(rw("window.location.hash = '#x';"), "__zl.hash = '#x';");
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
        // #532: document.baseURI renames to the virtual base view.
        assert_eq!(rw("var b = document.baseURI;"), "var b = __zl.baseURI;");
        assert_eq!(rw("var b = document['baseURI'];"), "var b = __zl.baseURI;");
        // writes, deletes and update targets stay native
        assert_eq!(rw("document.baseURI = '/x';"), "document.baseURI = '/x';");
        assert_eq!(rw("delete document.baseURI;"), "delete document.baseURI;");
        assert_eq!(rw("document.baseURI++;"), "document.baseURI++;");
        // a shadowed local document binding never renames
        let js = "function f(document) { return document.baseURI; }";
        assert_eq!(rw(js), js);
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
