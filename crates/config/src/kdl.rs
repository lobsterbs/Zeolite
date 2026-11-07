//! KDL v2-subset parser (port of kdl.ts). Covers exactly the
//! grammar the engine's data files use: nodes with
//! string/number/keyword args, name=value props, { children }
//! blocks, semicolons, // line comments and nested block
//! comments. Unsupported KDL features (raw and multiline strings,
//! line continuations) fail with a line number instead of being
//! silently misparsed, and errors carry the same
//! "kdl: line N: msg" text the TS parser throws.
//!
//! #616 hardening: MAX_SOURCE_BYTES, MAX_NODES and MAX_DEPTH bound
//! hostile input (the TS recursion on nested blocks would overflow
//! the stack on deep nesting; here it fails with a line number).

use std::fmt;

use crate::{MAX_DEPTH, MAX_NODES, MAX_SOURCE_BYTES};

/// One scalar: string, number, keyword or bareword (barewords
/// parse as strings, exactly like the TS parser returns them).
#[derive(Debug, Clone, PartialEq)]
pub enum KdlValue {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

/// One node: name, positional args, name=value props, child nodes.
/// props keeps insertion order; the prop() lookup resolves
/// duplicates the way the TS Record assignment does (last wins).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct KdlNode {
    pub name: String,
    pub args: Vec<KdlValue>,
    pub props: Vec<(String, KdlValue)>,
    pub children: Vec<KdlNode>,
}

impl KdlNode {
    /// Last-wins prop lookup, mirroring the TS Record semantics.
    pub fn prop(&self, key: &str) -> Option<&KdlValue> {
        self.props
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
}

/// Parse failure with the offending line (1-based).
#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub line: usize,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "kdl: line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ParseError {}

struct Cursor<'a> {
    src: &'a str,
    pos: usize,
    line: usize,
    nodes: usize,
}

fn fail(c: &Cursor, msg: impl Into<String>) -> ParseError {
    ParseError {
        line: c.line,
        message: msg.into(),
    }
}

fn peek(c: &Cursor) -> Option<u8> {
    c.src.as_bytes().get(c.pos).copied()
}

fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'-'
}

fn is_ident_char(b: u8) -> bool {
    is_ident_start(b) || is_digit(b)
}

/// Character at the cursor for error text; "end of input" at EOF.
fn char_at(c: &Cursor) -> String {
    match c.src.get(c.pos..).and_then(|s| s.chars().next()) {
        Some(ch) => format!("{:?}", ch),
        None => "end of input".to_string(),
    }
}

/// Spaces, tabs and carriage returns (newlines terminate nodes).
fn skip_inline(c: &mut Cursor) {
    while matches!(peek(c), Some(b' ') | Some(b'\t') | Some(b'\r')) {
        c.pos += 1;
    }
}

/// A block comment; KDL nests them.
fn skip_block_comment(c: &mut Cursor) -> Result<(), ParseError> {
    c.pos += 2;
    let mut depth = 1;
    while depth > 0 {
        let Some(ch) = peek(c) else {
            return Err(fail(c, "unclosed block comment"));
        };
        if ch == b'/' && c.src.as_bytes().get(c.pos + 1) == Some(&b'*') {
            depth += 1;
            c.pos += 2;
        } else if ch == b'*' && c.src.as_bytes().get(c.pos + 1) == Some(&b'/') {
            depth -= 1;
            c.pos += 2;
        } else {
            if ch == b'\n' {
                c.line += 1;
            }
            c.pos += 1;
        }
    }
    Ok(())
}

/// In-line gaps: spaces plus block comments. Stops at newlines and
/// line comments; both terminate the current node.
fn skip_gap(c: &mut Cursor) -> Result<(), ParseError> {
    loop {
        skip_inline(c);
        if peek(c) == Some(b'/') && c.src.as_bytes().get(c.pos + 1) == Some(&b'*') {
            skip_block_comment(c)?;
        } else {
            return Ok(());
        }
    }
}

/// All whitespace and comments, newlines included.
fn skip_space(c: &mut Cursor) -> Result<(), ParseError> {
    loop {
        skip_gap(c)?;
        if peek(c) == Some(b'\n') {
            c.pos += 1;
            c.line += 1;
        } else if peek(c) == Some(b'/') && c.src.as_bytes().get(c.pos + 1) == Some(&b'/') {
            while peek(c).is_some() && peek(c) != Some(b'\n') {
                c.pos += 1;
            }
        } else {
            return Ok(());
        }
    }
}

fn parse_ident(c: &mut Cursor) -> Result<String, ParseError> {
    if !peek(c).map(is_ident_start).unwrap_or(false) {
        return Err(fail(c, format!("expected a name, got {}", char_at(c))));
    }
    let start = c.pos;
    c.pos += 1;
    while peek(c).map(is_ident_char).unwrap_or(false) {
        c.pos += 1;
    }
    Ok(c.src[start..c.pos].to_string())
}

fn parse_string(c: &mut Cursor) -> Result<String, ParseError> {
    c.pos += 1; // opening quote
    let mut out = String::new();
    loop {
        let Some(b) = peek(c) else {
            return Err(fail(c, "unclosed string"));
        };
        if b == b'\n' {
            return Err(fail(c, "unclosed string"));
        }
        if b == b'"' {
            c.pos += 1;
            return Ok(out);
        }
        if b == b'\\' {
            let Some(esc) = c.src.as_bytes().get(c.pos + 1).copied() else {
                return Err(fail(c, "unclosed string"));
            };
            if esc == b'\n' {
                return Err(fail(c, "unclosed string"));
            }
            match esc {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'n' => out.push('\n'),
                b't' => out.push('\t'),
                b'r' => out.push('\r'),
                b'b' => out.push('\u{8}'),
                b'f' => out.push('\u{c}'),
                _ => return Err(fail(c, format!("unknown escape \\{}", esc as char))),
            }
            c.pos += 2;
        } else {
            let ch = c.src[c.pos..].chars().next().unwrap();
            out.push(ch);
            c.pos += ch.len_utf8();
        }
    }
}

fn parse_number(c: &mut Cursor) -> Result<f64, ParseError> {
    let start = c.pos;
    if peek(c) == Some(b'-') {
        c.pos += 1;
    }
    while peek(c).map(is_digit).unwrap_or(false) {
        c.pos += 1;
    }
    if peek(c) == Some(b'.') {
        c.pos += 1;
        if !peek(c).map(is_digit).unwrap_or(false) {
            return Err(fail(c, "malformed number"));
        }
        while peek(c).map(is_digit).unwrap_or(false) {
            c.pos += 1;
        }
    }
    if matches!(peek(c), Some(b'e') | Some(b'E')) {
        let save = c.pos;
        c.pos += 1;
        if matches!(peek(c), Some(b'+') | Some(b'-')) {
            c.pos += 1;
        }
        if !peek(c).map(is_digit).unwrap_or(false) {
            c.pos = save;
        } else {
            while peek(c).map(is_digit).unwrap_or(false) {
                c.pos += 1;
            }
        }
    }
    let n: f64 = c.src[start..c.pos]
        .parse()
        .map_err(|_| fail(c, "malformed number"))?;
    if n.is_nan() {
        return Err(fail(c, "malformed number"));
    }
    if let Some(after) = peek(c) {
        if !matches!(
            after,
            b' ' | b'\t' | b'\r' | b'\n' | b';' | b'{' | b'}' | b'/' | b'='
        ) {
            return Err(fail(c, "malformed number"));
        }
    }
    Ok(n)
}

/// #631: a keyword must end at a delimiter, mirroring parseNumber;
/// startsWith alone would split #truexyz into true plus a stray
/// bareword and silently misparse configs.
fn keyword(c: &mut Cursor, word: &str) -> Result<bool, ParseError> {
    if !c.src[c.pos..].starts_with(word) {
        return Ok(false);
    }
    if let Some(a) = c.src.as_bytes().get(c.pos + word.len()).copied() {
        if !matches!(
            a,
            b' ' | b'\t' | b'\r' | b'\n' | b';' | b'{' | b'}' | b'/' | b'='
        ) {
            return Err(fail(c, format!("malformed keyword {}", word)));
        }
    }
    c.pos += word.len();
    Ok(true)
}

fn parse_value(c: &mut Cursor) -> Result<KdlValue, ParseError> {
    let Some(ch) = peek(c) else {
        return Err(fail(c, format!("expected a value, got {}", char_at(c))));
    };
    if ch == b'"' {
        return Ok(KdlValue::Str(parse_string(c)?));
    }
    if ch == b'#' {
        if keyword(c, "#true")? {
            return Ok(KdlValue::Bool(true));
        }
        if keyword(c, "#false")? {
            return Ok(KdlValue::Bool(false));
        }
        if keyword(c, "#null")? {
            return Ok(KdlValue::Null);
        }
        return Err(fail(c, "unsupported # syntax (only #true #false #null)"));
    }
    if is_digit(ch) {
        return Ok(KdlValue::Num(parse_number(c)?));
    }
    if ch == b'-' && c.src.as_bytes().get(c.pos + 1).copied().map(is_digit) == Some(true) {
        return Ok(KdlValue::Num(parse_number(c)?));
    }
    if is_ident_start(ch) {
        return Ok(KdlValue::Str(parse_ident(c)?));
    }
    Err(fail(c, format!("expected a value, got {}", char_at(c))))
}

fn parse_entry(c: &mut Cursor, node: &mut KdlNode) -> Result<(), ParseError> {
    let Some(ch) = peek(c) else {
        return Err(fail(c, "unexpected end of input"));
    };
    if ch == b'"' {
        node.args.push(KdlValue::Str(parse_string(c)?));
        return Ok(());
    }
    if ch == b'#' {
        node.args.push(parse_value(c)?);
        return Ok(());
    }
    if is_digit(ch)
        || (ch == b'-' && c.src.as_bytes().get(c.pos + 1).copied().map(is_digit) == Some(true))
    {
        node.args.push(KdlValue::Num(parse_number(c)?));
        return Ok(());
    }
    if !is_ident_start(ch) {
        return Err(fail(c, format!("unexpected character {}", char_at(c))));
    }
    let word = parse_ident(c)?;
    skip_inline(c);
    if peek(c) == Some(b'=') {
        c.pos += 1;
        skip_inline(c);
        let v = parse_value(c)?;
        node.props.push((word, v));
    } else {
        node.args.push(KdlValue::Str(word));
    }
    Ok(())
}

fn parse_node(c: &mut Cursor, depth: usize) -> Result<KdlNode, ParseError> {
    c.nodes += 1;
    if c.nodes > MAX_NODES {
        return Err(fail(c, "too many nodes"));
    }
    let mut node = KdlNode {
        name: parse_ident(c)?,
        ..Default::default()
    };
    loop {
        skip_gap(c)?;
        let Some(ch) = peek(c) else {
            return Ok(node);
        };
        if ch == b'\n' {
            return Ok(node);
        }
        if ch == b';' {
            c.pos += 1;
            return Ok(node);
        }
        if ch == b'/' && c.src.as_bytes().get(c.pos + 1) == Some(&b'/') {
            return Ok(node);
        }
        if ch == b'}' {
            return Ok(node);
        }
        if ch == b'{' {
            if depth + 1 > MAX_DEPTH {
                return Err(fail(c, "nesting too deep"));
            }
            c.pos += 1;
            node.children = parse_children(c, depth + 1)?;
            if peek(c) != Some(b'}') {
                return Err(fail(c, "unclosed {"));
            }
            c.pos += 1;
            continue;
        }
        parse_entry(c, &mut node)?;
    }
}

fn parse_children(c: &mut Cursor, depth: usize) -> Result<Vec<KdlNode>, ParseError> {
    let mut nodes = Vec::new();
    loop {
        skip_space(c)?;
        let Some(ch) = peek(c) else {
            return Ok(nodes);
        };
        if ch == b'}' {
            return Ok(nodes);
        }
        nodes.push(parse_node(c, depth)?);
    }
}

/// Parse a KDL v2-subset document into nodes. Errors carry a line
/// number on malformed input; unsupported syntax fails loudly.
pub fn parse_kdl(source: &str) -> Result<Vec<KdlNode>, ParseError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(ParseError {
            line: 1,
            message: format!("document exceeds {} bytes", MAX_SOURCE_BYTES),
        });
    }
    let mut c = Cursor {
        src: source,
        pos: 0,
        line: 1,
        nodes: 0,
    };
    let mut nodes = Vec::new();
    loop {
        skip_space(&mut c)?;
        let Some(ch) = peek(&c) else {
            return Ok(nodes);
        };
        if ch == b'}' {
            return Err(fail(&c, "unexpected }"));
        }
        nodes.push(parse_node(&mut c, 0)?);
    }
}
