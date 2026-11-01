//! #525: import.meta.url string-value virtualization for module
//! bodies. Through the engine a module's import.meta.url is the
//! opaque engine route (token path), so pages doing string surgery
//! on it (startsWith checks, splitting off the file name, comparing
//! against a known URL) break while relative RESOLUTION still
//! works. This AST pass replaces import.meta.url READS with a string
//! literal of the module's virtual URL: the engine origin carrying
//! the real path/query/fragment, the same host-opaque shape the
//! virtual location view serves (#32/#144 contract). Direct control
//! value parity holds for the path; the host stays opaque by
//! design, exactly like __zl.href.
//!
//! Bounded v1 limits (honest, same style as the globals pass):
//! - import.meta.resolve stays native: bare-specifier resolution is
//!   the import-map question (#554), never a URL fold.
//! - Aliasing (const m = import.meta; m.url) and destructuring
//!   (const {url} = import.meta) stay native: the read happens
//!   through a binding this pass does not track.
//! - Writes/deletes/update targets stay native (the literal is not
//!   assignable, and import.meta.url is frozen anyway).
//! - Spaced token forms (import . meta) miss the fast path and stay
//!   native; broken JS and oversized bodies return unchanged.

use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::Expression;
use oxc_ast::ast_kind::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};

/// Same parse bound as the globals pass: huge bodies skip the AST.
pub const MAX_BYTES: usize = crate::js::globals::MAX_BYTES;

/// Replace import.meta.url reads with a string literal of the
/// module's virtual URL. Parse failures return the input unchanged.
pub fn rewrite_import_meta_url(js: &str, virtual_url: &str) -> String {
    if js.len() > MAX_BYTES || !js.contains("import.meta") {
        return js.to_string();
    }
    if !is_absolute_http(virtual_url) {
        return js.to_string();
    }
    let Some(edits) = collect(js) else {
        return js.to_string();
    };
    if edits.is_empty() {
        return js.to_string();
    }
    let lit = string_literal(virtual_url);
    let mut out = String::with_capacity(js.len() + lit.len());
    let mut pos = 0usize;
    for (start, end) in &edits {
        out.push_str(&js[pos..*start]);
        out.push_str(&lit);
        pos = *end;
    }
    out.push_str(&js[pos..]);
    out
}

fn is_absolute_http(u: &str) -> bool {
    (u.starts_with("https://") || u.starts_with("http://"))
        && u.find("://").is_some_and(|i| u[i + 3..].contains('/'))
}

/// Parse and collect the (start, end) byte spans of import.meta.url
/// reads, or None when the body parses as neither module nor script.
fn collect(js: &str) -> Option<Vec<(usize, usize)>> {
    let allocator = Allocator::default();
    let module = SourceType::default().with_module(true);
    let ret = Parser::new(&allocator, js, module).parse();
    let program = if ret.diagnostics.is_empty() {
        ret.program
    } else {
        let script = Parser::new(&allocator, js, SourceType::default()).parse();
        if script.diagnostics.is_empty() {
            script.program
        } else {
            return None;
        }
    };
    let mut w = Walker {
        native_targets: HashSet::new(),
        edits: Vec::new(),
    };
    w.visit_program(&program);
    w.edits.sort_by_key(|(s, _)| *s);
    Some(w.edits)
}

struct Walker {
    /// Assignment/update/delete targets keep their native receiver.
    native_targets: HashSet<Span>,
    edits: Vec<(usize, usize)>,
}

impl<'a> Visit<'a> for Walker {
    fn visit_simple_assignment_target(&mut self, it: &oxc_ast::ast::SimpleAssignmentTarget<'a>) {
        self.native_targets.insert(it.span());
        walk::walk_simple_assignment_target(self, it);
    }

    fn visit_unary_expression(&mut self, it: &oxc_ast::ast::UnaryExpression<'a>) {
        if it.operator.as_str() == "delete" {
            self.native_targets
                .insert(it.argument.get_inner_expression().span());
        }
        walk::walk_unary_expression(self, it);
    }

    fn enter_node(&mut self, kind: AstKind<'a>) {
        match kind {
            // import.meta.url: oxc's ImportMeta node IS import.meta by
            // construction (no meta/property fields to verify).
            AstKind::StaticMemberExpression(m) if m.property.name.as_str() == "url" => {
                if let Expression::ImportMeta(_) = &m.object {
                    if !self.native_targets.contains(&m.span) {
                        self.edits
                            .push((m.span.start as usize, m.span.end as usize));
                    }
                }
            }
            // Minified/obfuscated bundles reach for brackets; only a
            // string-literal key carries the static meaning.
            AstKind::ComputedMemberExpression(m) => {
                if let Expression::StringLiteral(lit) = &m.expression {
                    if lit.value.as_str() == "url" {
                        if let Expression::ImportMeta(_) = &m.object {
                            if !self.native_targets.contains(&m.span) {
                                self.edits
                                    .push((m.span.start as usize, m.span.end as usize));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

/// A double-quoted JS string literal. Built with from_u32 chars so
/// no escaped-literal source bytes can drift from the emitted bytes
/// (a literal quote or backslash in a module URL must never break
/// the rewritten body).
fn string_literal(url: &str) -> String {
    let bs = char::from_u32(92).unwrap();
    let q = char::from_u32(34).unwrap();
    let mut out = String::with_capacity(url.len() + 2);
    out.push(q);
    for c in url.chars() {
        let cp = c as u32;
        if c == q {
            out.push(bs);
            out.push(q);
        } else if c == bs {
            out.push(bs);
            out.push(bs);
        } else if cp == 10 {
            out.push(bs);
            out.push('n');
        } else if cp == 13 {
            out.push(bs);
            out.push('r');
        } else if cp == 9 {
            out.push(bs);
            out.push('t');
        } else if cp < 0x20 {
            out.push(bs);
            out.push('u');
            out.push_str(&format!("{:04x}", cp));
        } else {
            out.push(c);
        }
    }
    out.push(q);
    out
}

#[cfg(test)]
mod tests {
    use super::rewrite_import_meta_url as rw;

    const V: &str = "https://engine.host/dir/mods/rel.js?x=1";

    fn vl() -> String {
        let q = char::from_u32(34).unwrap();
        format!("{}{}{}", q, V, q)
    }

    #[test]
    fn dot_read_replaced() {
        assert_eq!(
            rw("String(import.meta.url)", V),
            format!("String({})", vl())
        );
    }

    #[test]
    fn bracket_literal_replaced() {
        assert_eq!(rw("import.meta['url']", V), vl());
    }

    #[test]
    fn computed_nonliteral_key_stays_native() {
        assert_eq!(rw("import.meta[k]", V), "import.meta[k]");
    }

    #[test]
    fn assignment_target_stays_native() {
        assert_eq!(rw("import.meta.url = '/x';", V), "import.meta.url = '/x';");
    }

    #[test]
    fn update_target_stays_native() {
        assert_eq!(rw("import.meta.url++;", V), "import.meta.url++;");
    }

    #[test]
    fn delete_stays_native() {
        assert_eq!(rw("delete import.meta.url;", V), "delete import.meta.url;");
    }

    #[test]
    fn aliasing_and_destructuring_stay_native() {
        let js = "const m = import.meta; const { url } = import.meta;";
        assert_eq!(rw(js, V), js);
    }

    #[test]
    fn resolve_stays_native() {
        assert_eq!(
            rw("import.meta.resolve('./x')", V),
            "import.meta.resolve('./x')"
        );
    }

    #[test]
    fn nested_read_in_call_replaced() {
        let out = rw("fetch(new URL('./x', import.meta.url).href)", V);
        assert_eq!(out, format!("fetch(new URL('./x', {}).href)", vl()));
    }

    #[test]
    fn read_inside_computed_key_replaced() {
        let out = rw("({ [import.meta.url]: 1 })", V);
        assert_eq!(out, format!("({{ [{}]: 1 }})", vl()));
    }

    #[test]
    fn string_text_untouched() {
        assert_eq!(
            rw("const s = 'import.meta.url';", V),
            "const s = 'import.meta.url';"
        );
    }

    #[test]
    fn no_token_no_change() {
        assert_eq!(rw("const a = 1;", V), "const a = 1;");
    }

    #[test]
    fn parse_failure_unchanged() {
        assert_eq!(rw("import.meta.url~~~", V), "import.meta.url~~~");
    }

    #[test]
    fn backslash_and_control_escaped() {
        let bs = char::from_u32(92).unwrap();
        let q = char::from_u32(34).unwrap();
        let mut url = String::from("https://e/p#'q");
        url.push(bs);
        url.push_str("u0001");
        url.push(char::from_u32(1).unwrap());
        let out = rw("import.meta.url", &url);
        let mut expect = String::new();
        expect.push(q);
        expect.push_str("https://e/p#'q");
        expect.push(bs);
        expect.push(bs);
        expect.push_str("u0001");
        expect.push(bs);
        expect.push_str("u0001");
        expect.push(q);
        assert_eq!(out, expect);
    }

    #[test]
    fn bad_virtual_url_unchanged() {
        assert_eq!(rw("import.meta.url", "not-a-url"), "import.meta.url");
        assert_eq!(rw("import.meta.url", "https://nohost"), "import.meta.url");
    }

    #[test]
    fn minified_chain_replaced() {
        let out = rw("export const u=import.meta.url.split('/').pop();", V);
        assert_eq!(out, format!("export const u={}.split('/').pop();", vl()));
    }
}
