//! Import map URL routing (#554).
//!
//! <script type=importmap> bodies are JSON, not executable JavaScript
//! (script_type_is_js already classifies them as data), and before #554
//! they passed through verbatim: bare-specifier keys still matched, but
//! their target URLs stayed upstream-shaped, so every mapped module
//! escaped the engine browser-direct (a cross-origin fetch the service
//! worker never sees), and relative targets resolved against the engine
//! route and died. This pass rewrites the map so resolution keeps
//! working through engine routes:
//!
//! - Top-level "imports" entries: bare keys keep their specifier (the
//!   browser matches the specifier text, which the engine never
//!   rewrites); URL-like EXACT keys are re-encoded as the engine route
//!   of the resolved key, the same string a rewritten module specifier
//!   carries, so the exact match still hits; every string value (and
//!   every element of an array value) is resolved against the document
//!   base and encoded as an engine route. "null" values stay null: the
//!   spec's block form keeps failing the load natively.
//! - "scopes" entries: a scope key prefixes the importing module's URL,
//!   which in page space is an engine route. Exact URL keys route
//!   exactly; prefix keys (trailing "/") are re-encoded through the
//!   path-preserving split shape (<origin>/zl/<origin-token>/<real
//!   path>) so the prefix stays visible for matching. Under a codec
//!   with no split form the prefix cannot be expressed as a route
//!   prefix at all, so those entries stay verbatim: they never matched
//!   through the engine before either (no regression, an honest
//!   residual). The scope's inner map is rewritten like "imports".
//! - Unknown top-level fields, duplicate keys and member order are
//!   preserved: the browser's lookup semantics do not shift.
//!
//! Invalid JSON is emitted unchanged: the browser fails the map with
//! the same native error it would have produced. Nothing here invents
//! Node-style package resolution.
//!
//! Honest limits:
//! - "imports" prefix keys (trailing "/") match specifier URL
//!   prefixes; page-space specifier URLs are per-file tokens whose
//!   paths are not visible, so a routed prefix key has nothing to
//!   prefix-match. Those entries still go through the split-shape rule:
//!   it matches the rare split-routed specifier and stays verbatim
//!   when the codec has no split form.
//! - Only the JSON is rewritten. Multiple or late import maps keep
//!   their native error behavior: nothing is added or removed.
//! - Bodies over IMPORTMAP_CAP bytes pass through unrewritten (a real
//!   import map is a few KB; a hostile document must not pin memory).

use std::fmt::Write as _;

/// Rewrite pass byte cap: maps larger than this pass through verbatim.
pub const IMPORTMAP_CAP: usize = 256 * 1024;

/* ---- minimal strict JSON (RFC 8259) --------------------------------- */
//
// The wasm crate deliberately carries no serde dependency: this parser
// plus serializer is a few hundred lines of pure Rust, keeps the wasm
// bundle small, and fails closed (any parse error returns the original
// text unchanged, so the browser sees exactly what it would have seen).

/// Parsed JSON value. Numbers keep their lexeme verbatim (no f64
/// round-trip can corrupt 1e999), and objects keep member order and
/// duplicates (the browser's lookup takes the last duplicate; every
/// copy is rewritten the same way, so the semantics do not shift).
pub enum Json {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

struct JsonParser<'a> {
    b: &'a [u8],
    i: usize,
    depth: u8,
}

/// Hostile nesting must not overflow the stack: real import maps are
/// three levels deep. JSON.parse in the browser accepts deeper trees,
/// so a deeper map only loses the rewrite (verbatim passthrough), it
/// never fails the page.
const JSON_DEPTH_CAP: u8 = 64;

/// Parse one complete JSON document (strict RFC 8259: no trailing
/// garbage, no raw control characters in strings, valid escapes only).
pub fn parse_json(src: &str) -> Option<Json> {
    JsonParser {
        b: src.as_bytes(),
        i: 0,
        depth: 0,
    }
    .parse()
}

impl<'a> JsonParser<'a> {
    fn parse(mut self) -> Option<Json> {
        let v = self.value()?;
        self.skip_ws();
        if self.i != self.b.len() {
            return None; // trailing content: JSON.parse throws
        }
        Some(v)
    }

    fn skip_ws(&mut self) {
        while matches!(
            self.b.get(self.i),
            Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')
        ) {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Option<Json> {
        if self.depth >= JSON_DEPTH_CAP {
            return None;
        }
        self.skip_ws();
        let c = *self.b.get(self.i)?;
        self.depth += 1;
        let out = match c {
            b'{' => {
                self.i += 1;
                self.obj()
            }
            b'[' => {
                self.i += 1;
                self.arr()
            }
            b'"' => {
                self.i += 1;
                self.string().map(Json::Str)
            }
            b't' => self.lit("true", Json::Bool(true)),
            b'f' => self.lit("false", Json::Bool(false)),
            b'n' => self.lit("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        };
        self.depth -= 1;
        out
    }

    fn lit(&mut self, word: &str, v: Json) -> Option<Json> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }

    fn obj(&mut self) -> Option<Json> {
        let mut members: Vec<(String, Json)> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Some(Json::Obj(members));
        }
        loop {
            self.skip_ws();
            if *self.b.get(self.i)? != b'"' {
                return None;
            }
            self.i += 1;
            let key = self.string()?;
            self.skip_ws();
            if *self.b.get(self.i)? != b':' {
                return None;
            }
            self.i += 1;
            let val = self.value()?;
            members.push((key, val));
            self.skip_ws();
            match *self.b.get(self.i)? {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Some(Json::Obj(members));
                }
                _ => return None,
            }
        }
    }

    fn arr(&mut self) -> Option<Json> {
        let mut items: Vec<Json> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Some(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match *self.b.get(self.i)? {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Some(Json::Arr(items));
                }
                _ => return None,
            }
        }
    }

    /// One JSON string (opening quote already consumed). Escapes are
    /// decoded; a \u escape with an unpaired surrogate is a parse
    /// error: Rust strings cannot hold it, and the pass then keeps the
    /// original bytes verbatim instead of corrupting them.
    fn string(&mut self) -> Option<String> {
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i)?;
            match c {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if self.b.get(self.i) != Some(&b'\\')
                                    || self.b.get(self.i + 1) != Some(&b'u')
                                {
                                    return None;
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return None;
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return None; // unpaired low surrogate
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp)?);
                        }
                        _ => return None,
                    }
                }
                0x00..=0x1F => return None, // raw control character
                _ => {
                    // One UTF-8 character: validate instead of
                    // splitting a sequence (a lone continuation byte
                    // is a parse error, matching from_utf8 losslessly).
                    let start = self.i;
                    let len = match c {
                        0x20..=0x7F => 1,
                        0xC2..=0xDF => 2,
                        0xE0..=0xEF => 3,
                        0xF0..=0xF4 => 4,
                        _ => return None,
                    };
                    if start + len > self.b.len() {
                        return None;
                    }
                    out.push_str(std::str::from_utf8(&self.b[start..start + len]).ok()?);
                    self.i += len;
                }
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        if self.i + 4 > self.b.len() {
            return None;
        }
        let s = std::str::from_utf8(&self.b[self.i..self.i + 4]).ok()?;
        let v = u32::from_str_radix(s, 16).ok()?;
        self.i += 4;
        Some(v)
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.i;
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        match self.b.get(self.i)? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                    self.i += 1;
                }
            }
            _ => return None,
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        if matches!(self.b.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if !matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                return None;
            }
            while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                self.i += 1;
            }
        }
        Some(Json::Num(
            String::from_utf8(self.b[start..self.i].to_vec()).ok()?,
        ))
    }
}

/* ---- serialization --------------------------------------------------- */

/// Compact JSON serialization. Strings re-escape quotes, backslashes
/// and control characters; non-ASCII stays raw UTF-8 (valid JSON).
pub fn json_serialize(v: &Json) -> String {
    let mut out = String::new();
    ser(v, &mut out);
    out
}

fn ser(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Num(n) => out.push_str(n),
        Json::Str(s) => {
            out.push('"');
            escape_into(s, out);
            out.push('"');
        }
        Json::Arr(items) => {
            out.push('[');
            for (n, it) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                ser(it, out);
            }
            out.push(']');
        }
        Json::Obj(m) => {
            out.push('{');
            for (n, (k, val)) in m.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                out.push('"');
                escape_into(k, out);
                out.push_str("\":");
                ser(val, out);
            }
            out.push('}');
        }
    }
}

fn escape_into(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
}

/* ---- key classification ---------------------------------------------- */

/// A key the browser matches against the specifier text itself: bare
/// specifiers ("lodash") and bare prefix keys ("lodash/"). URL-like
/// keys (a scheme before the first "/", or "/", "./", "../" forms)
/// match specifier URLs instead and must be re-encoded.
fn key_is_bare(k: &str) -> bool {
    if k.starts_with('/') || k.starts_with("./") || k.starts_with("../") {
        return false;
    }
    match k.find(':') {
        Some(ci) => !(ci > 0 && crate::encode::is_scheme(&k[..ci])),
        None => true,
    }
}

/* ---- the rewrite ------------------------------------------------------ */

/// Route every URL in an import map value: string values and the
/// string elements of array values. Null (the block form), booleans,
/// numbers and anything else the spec does not define stay verbatim.
/// Route one prefix-key VALUE through the path-preserving split form.
/// The import map spec requires a trailing-slash key's address to
/// end with a slash too; an opaque token route never does, so the
/// browser would ignore the whole entry (observed in the #554 browser
/// suite: an address like /j/<token> does not end in '/'). The split
/// form carries the path verbatim after the origin token, so the
/// slash survives and prefix matching still works. When the codec
/// has no split form the value stays verbatim: the entry then keeps
/// its upstream address (cross-origin page imports still ride the
/// engine through the fetch seam) instead of being ignored.
fn rewrite_value_split(v: Json, enc_split: &dyn Fn(&str) -> Option<String>) -> Json {
    match v {
        Json::Str(s) => match enc_split(&s) {
            Some(n) => Json::Str(n),
            None => Json::Str(s),
        },
        Json::Arr(items) => Json::Arr(
            items
                .into_iter()
                .map(|it| match it {
                    Json::Str(s) => match enc_split(&s) {
                        Some(n) => Json::Str(n),
                        None => Json::Str(s),
                    },
                    other => other,
                })
                .collect(),
        ),
        other => other,
    }
}

fn rewrite_value(v: Json, enc: &dyn Fn(&str) -> String) -> Json {
    match v {
        Json::Str(s) => Json::Str(enc(&s)),
        Json::Arr(items) => Json::Arr(
            items
                .into_iter()
                .map(|it| match it {
                    Json::Str(s) => Json::Str(enc(&s)),
                    other => other,
                })
                .collect(),
        ),
        other => other,
    }
}

/// One (key, value) entry of an imports-shaped map. Bare keys keep
/// their text; URL-like exact keys re-encode through enc (the same
/// route a rewritten specifier carries, so the exact match still
/// hits); prefix keys (trailing "/") re-encode through enc_prefix
/// and stay fully verbatim when the codec has no split form (they
/// cannot match through the engine either way; no new leak beyond the
/// historical passthrough).
fn rewrite_entry(
    k: String,
    v: Json,
    enc: &dyn Fn(&str) -> String,
    enc_prefix: &dyn Fn(&str) -> Option<String>,
    enc_split: &dyn Fn(&str) -> Option<String>,
) -> (String, Json) {
    if key_is_bare(&k) {
        if k.ends_with('/') {
            return (k, rewrite_value_split(v, enc_split));
        }
        return (k, rewrite_value(v, enc));
    }
    if k.ends_with('/') {
        return match enc_prefix(&k) {
            Some(nk) => (nk, rewrite_value_split(v, enc_split)),
            None => (k, v),
        };
    }
    (enc(&k), rewrite_value(v, enc))
}

fn rewrite_map(
    map: Vec<(String, Json)>,
    enc: &dyn Fn(&str) -> String,
    enc_prefix: &dyn Fn(&str) -> Option<String>,
    enc_split: &dyn Fn(&str) -> Option<String>,
) -> Json {
    Json::Obj(
        map.into_iter()
            .map(|(k, v)| rewrite_entry(k, v, enc, enc_prefix, enc_split))
            .collect(),
    )
}

/// Rewrite one import map body. enc routes a URL (resolving relative
/// forms against the document base); enc_prefix routes a trailing
/// slash prefix key into the path-preserving split form, or returns
/// None when the codec cannot express it. Any parse failure, an
/// over-cap body, or a non-object root is returned unchanged: the
/// browser produces exactly its native error.
pub fn rewrite_importmap(
    raw: &str,
    enc: &dyn Fn(&str) -> String,
    enc_prefix: &dyn Fn(&str) -> Option<String>,
    enc_split: &dyn Fn(&str) -> Option<String>,
) -> String {
    if raw.len() > IMPORTMAP_CAP {
        return raw.to_string();
    }
    let members = match parse_json(raw) {
        Some(Json::Obj(members)) => members,
        _ => return raw.to_string(),
    };
    let out: Vec<(String, Json)> = members
        .into_iter()
        .map(|(k, v)| {
            let imports = k == "imports";
            let scopes = k == "scopes";
            match v {
                Json::Obj(map) if imports => (k, rewrite_map(map, enc, enc_prefix, enc_split)),
                Json::Obj(scope_map) if scopes => {
                    let inner: Vec<(String, Json)> = scope_map
                        .into_iter()
                        .map(|(sk, sv)| match sv {
                            Json::Obj(map) => rewrite_entry(
                                sk,
                                rewrite_map(map, enc, enc_prefix, enc_split),
                                enc,
                                enc_prefix,
                                enc_split,
                            ),
                            other => (sk, other),
                        })
                        .collect();
                    (k, Json::Obj(inner))
                }
                other => (k, other),
            }
        })
        .collect();
    json_serialize(&Json::Obj(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc_upper(u: &str) -> String {
        format!("R({})", u)
    }
    fn enc_pfx(u: &str) -> Option<String> {
        Some(format!("P[{}]", u))
    }
    fn enc_pfx_none(_u: &str) -> Option<String> {
        None
    }
    fn enc_split_some(u: &str) -> Option<String> {
        Some(format!("S[{}]", u))
    }
    fn enc_split_none(_u: &str) -> Option<String> {
        None
    }

    fn round(src: &str) -> String {
        rewrite_importmap(src, &enc_upper, &enc_pfx, &enc_split_some)
    }

    #[test]
    fn parses_the_rfc_vectors() {
        assert!(matches!(parse_json("{}"), Some(Json::Obj(_))));
        assert!(matches!(parse_json("[]"), Some(Json::Arr(_))));
        assert!(matches!(parse_json(" 1 "), Some(Json::Num(_))));
        assert!(matches!(parse_json("1e999"), Some(Json::Num(n)) if n == "1e999"));
        assert!(matches!(parse_json("true"), Some(Json::Bool(true))));
        assert!(matches!(parse_json("null"), Some(Json::Null)));
    }

    #[test]
    fn parse_rejects_invalid_documents() {
        for bad in [
            "{}x",
            "{\"a\":}",
            "{'a':1}",
            "[1,]",
            "{\"a\" 1}",
            "\"\\x12\"",
            "\"a\nb\"",
            "01",
            "+1",
            ".5",
            "1.",
            "\"\\uD800\"",
            "\"\u{FFFD}ok",
        ] {
            assert!(parse_json(bad).is_none(), "should reject: {}", bad);
        }
    }

    #[test]
    fn serialize_round_trips() {
        let src = "{\"a\":[1,-2.5e3,true,null,\"s\\n\",\"\u{00E9}\"]}";
        let v = parse_json(src).unwrap();
        let ser = json_serialize(&v);
        let back = parse_json(&ser).unwrap();
        assert!(shape_eq(&v, &back));
    }

    /// Structural equality (Json has no derive).
    fn shape_eq(a: &Json, b: &Json) -> bool {
        match (a, b) {
            (Json::Null, Json::Null) => true,
            (Json::Bool(x), Json::Bool(y)) => x == y,
            (Json::Num(x), Json::Num(y)) => x == y,
            (Json::Str(x), Json::Str(y)) => x == y,
            (Json::Arr(x), Json::Arr(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(i, j)| shape_eq(i, j))
            }
            (Json::Obj(x), Json::Obj(y)) => {
                x.len() == y.len()
                    && x.iter()
                        .zip(y)
                        .all(|((k1, v1), (k2, v2))| k1 == k2 && shape_eq(v1, v2))
            }
            _ => false,
        }
    }

    #[test]
    fn bare_keys_keep_their_specifier_and_values_route() {
        let out = round("{\"imports\":{\"lodash\":\"https://cdn.example/l.js\"}}");
        assert_eq!(
            out,
            "{\"imports\":{\"lodash\":\"R(https://cdn.example/l.js)\"}}"
        );
    }

    #[test]
    fn bare_prefix_keys_keep_their_text_and_the_value_keeps_its_slash() {
        /* A trailing-slash key's address must end with a slash or the
        browser ignores the entry: the value rides the split form,
        never the opaque token route. */
        let out = round("{\"imports\":{\"lodash/\":\"https://cdn.example/l/\"}}");
        assert!(
            out.contains("\"lodash/\":\"S[https://cdn.example/l/]\""),
            "{}",
            out
        );
        let none = rewrite_importmap(
            "{\"imports\":{\"lodash/\":\"https://cdn.example/l/\"}}",
            &enc_upper,
            &enc_pfx,
            &enc_split_none,
        );
        assert_eq!(
            none,
            "{\"imports\":{\"lodash/\":\"https://cdn.example/l/\"}}"
        );
    }

    #[test]
    fn url_exact_keys_reencode_and_match_the_specifier_route() {
        let out =
            round("{\"imports\":{\"https://cdn.example/lib.js\":\"https://cdn.example/l.js\"}}");
        assert_eq!(
            out,
            "{\"imports\":{\"R(https://cdn.example/lib.js)\":\"R(https://cdn.example/l.js)\"}}"
        );
    }

    #[test]
    fn prefix_keys_use_the_split_form_and_stay_verbatim_without_one() {
        let out = round("{\"imports\":{\"https://cdn.example/lib/\":\"https://cdn.example/l/\"}}");
        assert!(out.contains("\"P[https://cdn.example/lib/]\""), "{}", out);
        assert!(
            out.contains("\"S[https://cdn.example/l/]\""),
            "prefix value keeps its trailing slash: {}",
            out
        );
        let none = rewrite_importmap(
            "{\"imports\":{\"https://cdn.example/lib/\":\"https://cdn.example/l/\"}}",
            &enc_upper,
            &enc_pfx_none,
            &enc_split_some,
        );
        assert_eq!(
            none,
            "{\"imports\":{\"https://cdn.example/lib/\":\"https://cdn.example/l/\"}}"
        );
    }

    #[test]
    fn null_values_block_and_arrays_route_every_element() {
        let out = round(
            "{\"imports\":{\"blocked\":null,\"multi\":[\"https://a.example/1.js\",\"https://b.example/2.js\"]}}",
        );
        assert!(out.contains("\"blocked\":null"), "{}", out);
        assert!(
            out.contains("\"multi\":[\"R(https://a.example/1.js)\",\"R(https://b.example/2.js)\"]"),
            "{}",
            out
        );
    }

    #[test]
    fn scopes_rewrite_keys_and_inner_maps() {
        let out = round(
            "{\"scopes\":{\"https://site.example/app/\":{\"widget\":\"https://cdn.example/w.js\"}}}",
        );
        assert!(out.contains("\"P[https://site.example/app/]\""), "{}", out);
        assert!(
            out.contains("\"widget\":\"R(https://cdn.example/w.js)\""),
            "{}",
            out
        );
    }

    #[test]
    fn unknown_root_fields_and_duplicates_are_preserved() {
        let out = round(
            "{\"imports\":{\"a\":\"https://a.example/1.js\"},\"integrity\":{\"k\":1},\"x\":[true,2e3],\"imports\":{\"b\":\"https://b.example/2.js\"}}",
        );
        assert!(out.contains("\"integrity\":{\"k\":1}"), "{}", out);
        assert!(out.contains("\"x\":[true,2e3]"), "{}", out);
        assert_eq!(out.matches("\"imports\":").count(), 2, "{}", out);
        assert!(
            out.contains("\"a\":\"R(https://a.example/1.js)\""),
            "{}",
            out
        );
        assert!(
            out.contains("\"b\":\"R(https://b.example/2.js)\""),
            "{}",
            out
        );
    }

    #[test]
    fn invalid_json_and_non_object_roots_pass_through_verbatim() {
        for raw in ["not json", "[1,2]", "\"map\"", "42", ""] {
            assert_eq!(round(raw), raw);
        }
    }

    #[test]
    fn relative_targets_resolve_through_the_encoder() {
        // The html rewriter's enc() resolves against the document
        // base; the passthrough fake records the value it received.
        let out = round("{\"imports\":{\"app\":\"./app.js\"}}");
        assert!(out.contains("\"app\":\"R(./app.js)\""), "{}", out);
    }

    #[test]
    fn escapes_survive_the_round_trip() {
        let out = round("{\"imports\":{\"k\":\"https://a.example/?q=a\\\"b\\\\c\\u0041\"}}");
        assert!(
            out.contains("\"R(https://a.example/?q=a\\\"b\\\\cA)\""),
            "{}",
            out
        );
    }

    #[test]
    fn over_cap_bodies_pass_through() {
        let huge = format!(
            "{{\"imports\":{{\"k\":\"{}\"}}}}",
            "x".repeat(IMPORTMAP_CAP)
        );
        assert_eq!(
            rewrite_importmap(&huge, &enc_upper, &enc_pfx, &enc_split_some),
            huge
        );
    }
}
