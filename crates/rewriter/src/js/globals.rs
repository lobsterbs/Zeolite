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
//!   -> __zl
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
//!   would change the key.
//! - scripts over MAX_BYTES or without the token "location" skip
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
    // Fast path: nothing to rename without the token.
    if !js.contains("location") || js.len() > MAX_BYTES {
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
    let mut out = String::with_capacity(js.len() + edits.len() * (VLOC.len() + 1));
    let mut pos = 0usize;
    for (start, end) in &edits {
        out.push_str(&js[pos..*start]);
        out.push_str(VLOC);
        pos = *end;
    }
    out.push_str(&js[pos..]);
    out
}

/// Parse and collect the (start, end) byte spans to replace, or None
/// when the body does not parse as module or script.
fn collect(js: &str) -> Option<Vec<(usize, usize)>> {
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
    w.edits.sort_by_key(|(s, _)| *s);
    Some(w.edits)
}

struct Walker<'a, 's> {
    sem: &'s Semantic<'a>,
    src: &'s str,
    /// Shorthand property values ({ location }): renaming the value
    /// would change the key, so their spans are excluded.
    shorthand: HashSet<Span>,
    edits: Vec<(usize, usize)>,
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
                            .push((id.span.start as usize, id.span.end as usize));
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
                            .push((m.span.start as usize, m.span.end as usize));
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
        while i < b.len() && matches!(b[i], b' ' | 0x09 | 0x0a | 0x0d) {
            i += 1;
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
                trimmed.ends_with("delete") && (i == 0 || !is_ident_byte(trimmed.as_bytes()[i - 1]))
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
    fn other_receivers_and_computed_stay_native() {
        let js = "var p = x.location.pathname; var q = window['location'];";
        assert_eq!(rw(js), js);
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
