//! Frame-buster neutralization, ported from the sibling project's
//! server-side pass for feature parity (that engine applies it to every
//! served script; until this port the wasm rewriter had no counterpart,
//! a documented gap).
//!
//! Proxied pages render inside the app's UI frame, so `top` is
//! cross-origin from the page's perspective. Classic frame-buster code
//! (`if (top != self) top.location = location`) then throws a
//! SecurityError at the top level of the script, aborting every
//! statement after it. Two rewrites restore top-level semantics:
//!
//! - framed-detection guards fold to their "not framed" values;
//! - `top.location` navigation writes sink into a harmless property
//!   (page code must never navigate the UI shell), reads map to the
//!   page's own location.
//!
//! Sink naming: method-call sinks use optional chaining
//! (`self.zl_antiframe?.replace?.(u)`) so they are silent no-ops with
//! NO runtime definitions required — the rewriter only rewrites, it
//! cannot inject definitions into every script context, and a bare
//! `self.zl_antiframe_replace(u)` would throw ReferenceError wherever
//! the property is undefined. Plain assignments
//! (`self.zl_antiframe = u`) are always safe: assigning an
//! undeclared property creates it.

/// Neutralize frame-buster code in a script body (or inline handler).
pub fn antiframe(js: &str) -> String {
    let mut s = replace_bound(js, "window.self", "self");
    s = replace_bound(&s, "window.top", "top");
    s = replace_bound(&s, "window.parent", "parent");
    // #208: every framing reference folds, not just 'top' vs 'self':
    // any comparison between top, parent, self and window becomes
    // 'self op self', both orders, spaced and compact. '==' folds to
    // true ("you are top", proceed), '!=' to false (the frame-buster
    // body never runs).
    for a in ["top", "parent", "window", "self"] {
        for b in ["top", "parent", "window", "self"] {
            if a == "self" && b == "self" {
                continue;
            }
            for op in ["==", "===", "!=", "!=="] {
                s = replace_bound(&s, &format!("{a} {op} {b}"), &format!("self {op} self"));
                s = replace_bound(&s, &format!("{a}{op}{b}"), &format!("self{op}self"));
            }
        }
    }
    antiframe_scan(&s)
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Substring replace that respects identifier boundaries, so
/// `window.topology` never matches the `window.top` pattern.
fn replace_bound(s: &str, pat: &str, rep: &str) -> String {
    let bytes = s.as_bytes();
    let pb = pat.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        // #208: string literals are data, never code - fold patterns
        // inside them would corrupt page strings.
        if bytes[i] == b'"' || bytes[i] == b'\'' || bytes[i] == b'`' {
            match find_str_end(s, i) {
                Some(end) => {
                    out.push_str(&s[i..end]);
                    i = end;
                    continue;
                }
                None => {
                    out.push_str(&s[i..]);
                    break;
                }
            }
        }
        if bytes[i..].starts_with(pb)
            && (i == 0 || (!is_ident(bytes[i - 1]) && bytes[i - 1] != b'.'))
            && (i + pb.len() >= bytes.len() || !is_ident(bytes[i + pb.len()]))
        {
            out.push_str(rep);
            i += pb.len();
            continue;
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// #208: offset just past the closing quote of the string literal
/// starting at the quote byte s[start]. None when unterminated.
fn find_str_end(s: &str, start: usize) -> Option<usize> {
    let b = s.as_bytes();
    let q = b[start];
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            c if c == q => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// Second pass: classify each `top.location` / `parent.location` use.
/// Navigation writes sink into the zl_antiframe property (no
/// navigation, no exception, the script keeps running); reads become
/// same-origin reads of the page's own location. Method-call sinks
/// are optional-chained so they are silent no-ops without any runtime
/// definitions (see module docs).
fn antiframe_scan(s: &str) -> String {
    // #208: parent.location is as cross-frame as top.location; the
    // page's own window.location is never touched.
    const TOKS: [&[u8]; 2] = [b"top.location", b"parent.location"];
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 32);
    let mut i = 0usize;
    while i < bytes.len() {
        // #208: string literals are data, never code.
        if bytes[i] == b'"' || bytes[i] == b'\'' || bytes[i] == b'`' {
            match find_str_end(s, i) {
                Some(end) => {
                    out.push_str(&s[i..end]);
                    i = end;
                    continue;
                }
                None => {
                    out.push_str(&s[i..]);
                    break;
                }
            }
        }
        let mut tlen = 0usize;
        for tok in TOKS {
            if bytes[i..].starts_with(tok)
                && (i == 0 || !(bytes[i - 1] == b'.' || is_ident(bytes[i - 1])))
                && (i + tok.len() >= bytes.len() || !is_ident(bytes[i + tok.len()]))
            {
                tlen = tok.len();
                break;
            }
        }
        if tlen == 0 {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        scan_sink(bytes, &mut i, &mut out, tlen);
    }
    out
}

/// Classify one matched top.location / parent.location token and
/// emit its replacement (#208: both cross-frame references sink).
fn scan_sink(bytes: &[u8], i: &mut usize, out: &mut String, tlen: usize) {
    let after = *i + tlen;
    let mut j = after;
    while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r') {
        j += 1;
    }
    let is_write =
        j < bytes.len() && bytes[j] == b'=' && (j + 1 >= bytes.len() || bytes[j + 1] != b'=');
    if is_write {
        out.push_str("self.zl_antiframe");
        *i += tlen;
        return;
    }
    if bytes[j..].starts_with(b".href") {
        let mut k = j + 5;
        while k < bytes.len() && matches!(bytes[k], b' ' | b'\t' | b'\n' | b'\r') {
            k += 1;
        }
        if k < bytes.len() && bytes[k] == b'=' && (k + 1 >= bytes.len() || bytes[k + 1] != b'=') {
            out.push_str("self.zl_antiframe");
            *i += tlen + 5;
            return;
        }
    }
    if bytes[j..].starts_with(b".replace") {
        out.push_str("self.zl_antiframe?.replace?.");
        *i += tlen + 8;
        return;
    }
    if bytes[j..].starts_with(b".reload") {
        out.push_str("self.zl_antiframe?.reload?.");
        *i += tlen + 7;
        return;
    }
    if bytes[j..].starts_with(b".assign") {
        out.push_str("self.zl_antiframe?.assign?.");
        *i += tlen + 7;
        return;
    }
    out.push_str("self.location");
    *i += tlen;
}

#[cfg(test)]
mod tests {
    use super::antiframe;

    #[test]
    fn folds_framed_guards() {
        let out = antiframe(
            "if (self != self) {\n  self.zl_antiframe = location;\n}\nalert('rest of app');",
        );
        assert_eq!(
            out,
            "if (self != self) {\n  self.zl_antiframe = location;\n}\nalert('rest of app');"
        );
    }

    #[test]
    fn sinks_navigation_writes() {
        let out =
            antiframe("top.location.href = u; top.location.replace(x); top.location.reload();");
        assert_eq!(
            out,
            "self.zl_antiframe = u; self.zl_antiframe?.replace?.(x); self.zl_antiframe?.reload?.();"
        );
        let out2 = antiframe("top.location.assign(y)");
        assert_eq!(out2, "self.zl_antiframe?.assign?.(y)");
        let out3 = antiframe("top.location = u");
        assert_eq!(out3, "self.zl_antiframe = u");
    }

    #[test]
    fn reads_map_to_own_location() {
        let out = antiframe("var here = top.location.href;");
        assert_eq!(out, "var here = self.location.href;");
    }

    #[test]
    fn window_prefixed_forms() {
        let out = antiframe(
            "if (window.top != window.self) { window.top.location = document.location; }",
        );
        assert_eq!(
            out,
            "if (self != self) { self.zl_antiframe = document.location; }"
        );
    }

    #[test]
    fn ident_boundaries_respected() {
        // `window.topology` must never match the `window.top` pattern.
        let out = antiframe("var window.topology; var laptop = 1;");
        assert_eq!(out, "var window.topology; var laptop = 1;");
        // `top.locationary` is a different property: the token match
        // must not fire.
        let out2 = antiframe("var q = top.locationary;");
        assert_eq!(out2, "var q = top.locationary;");
    }

    #[test]
    fn comparison_operators_fold() {
        let out = antiframe("if(top!=self){top.location=location}");
        assert_eq!(out, "if(self!=self){self.zl_antiframe=location}");
        let out2 = antiframe("if (self !== top) { self.zl_antiframe = document.location; }");
        assert_eq!(
            out2,
            "if (self !== self) { self.zl_antiframe = document.location; }"
        );
    }

    /// #208: every framing reference folds - top, parent and window,
    /// both orders, spaced and compact.
    #[test]
    fn top_vs_window_and_parent_guards_fold() {
        let out = antiframe("if (top != window) { self.zl_antiframe = 'x'; }");
        assert_eq!(out, "if (self != self) { self.zl_antiframe = 'x'; }");
        let out = antiframe("if (parent !== self) { bust(); }");
        assert_eq!(out, "if (self !== self) { bust(); }");
        let out = antiframe("if (window!==top){bust()}");
        assert_eq!(out, "if (self!==self){bust()}");
        let out = antiframe("if (parent == window) { init(); }");
        assert_eq!(out, "if (self == self) { init(); }");
        // parent.location sinks and reads like top.location.
        let out = antiframe("parent.location.href = u;");
        assert_eq!(out, "self.zl_antiframe = u;");
        let out = antiframe("var p = parent.location;");
        assert_eq!(out, "var p = self.location;");
    }

    /// #208: fold and sink patterns never fire inside string
    /// literals.
    #[test]
    fn string_literals_are_never_folded() {
        let out = antiframe("var s = 'top != self'; var t = \"top.location = x\";");
        assert_eq!(out, "var s = 'top != self'; var t = \"top.location = x\";");
    }
}
