//! #616 kdl oracle: kdl.test.ts ported row for row. The TS
//! corpus is the spec: any diff against it is a bug in this
//! port, never a behavior change. Plus the #616 cap rows.

use zeolite_config::kdl::parse_kdl;
use zeolite_config::kdl::KdlValue::{Bool, Null, Num, Str};
use zeolite_config::{MAX_NODES, MAX_SOURCE_BYTES};

fn err(src: &str) -> (usize, String) {
    match parse_kdl(src) {
        Ok(_) => panic!("expected a parse error for: {}", src),
        Err(e) => (e.line, e.message),
    }
}

#[test]
fn parses_flat_nodes_with_string_args() {
    let doc = parse_kdl("block \"doubleclick.net\"\nallow \"example.com\"").unwrap();
    let names: Vec<&str> = doc.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, ["block", "allow"]);
    assert_eq!(doc[0].args, [Str("doubleclick.net".into())]);
    assert_eq!(doc[1].args, [Str("example.com".into())]);
}

#[test]
fn parses_scalars_numbers_keywords_barewords() {
    let doc = parse_kdl("node 42 -7 3.5 2e3 0.5 #true #false #null bareword").unwrap();
    assert_eq!(
        doc[0].args,
        [
            Num(42.0),
            Num(-7.0),
            Num(3.5),
            Num(2000.0),
            Num(0.5),
            Bool(true),
            Bool(false),
            Null,
            Str("bareword".into()),
        ]
    );
}

#[test]
fn parses_props_with_string_escapes() {
    let doc = parse_kdl(r#"node key="a \"q\" b" slash="\/" nl="a\nb" tab="\t""#).unwrap();
    assert_eq!(
        doc[0].props,
        [
            ("key".into(), Str("a \"q\" b".into())),
            ("slash".into(), Str("/".into())),
            ("nl".into(), Str("a\nb".into())),
            ("tab".into(), Str("\t".into())),
        ]
    );
    assert_eq!(doc[0].args, []);
}

#[test]
fn parses_children_blocks_and_semicolons() {
    let doc =
        parse_kdl("site \"youtube.com\" {\n  inject \"/a.js\";\n  block \"ad.x\"\n}").unwrap();
    let names: Vec<&str> = doc[0].children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["inject", "block"]);
    assert_eq!(doc[0].children[0].args, [Str("/a.js".into())]);
    let inline = parse_kdl("a \"x\" { b \"y\"; c \"z\" }").unwrap();
    let firsts: Vec<zeolite_config::kdl::KdlValue> = inline[0]
        .children
        .iter()
        .map(|c| c.args[0].clone())
        .collect();
    assert_eq!(firsts, [Str("y".into()), Str("z".into())]);
}

#[test]
fn skips_line_and_block_comments_nested() {
    let doc = parse_kdl("// line\n/* block\nstill /* nested */ ok */\nnode \"v\"").unwrap();
    assert_eq!(doc.len(), 1);
    assert_eq!(doc[0].args, [Str("v".into())]);
}

#[test]
fn returns_no_nodes_for_empty_or_comment_only_input() {
    assert_eq!(parse_kdl("").unwrap(), []);
    assert_eq!(parse_kdl("// only\n/* comments */").unwrap(), []);
}

#[test]
fn throws_with_a_line_number_on_malformed_input() {
    assert_eq!(err("block \"oops"), (1, "unclosed string".into()));
    assert_eq!(err("a {\n b \"x\"\n").0, 3);
    assert_eq!(err("}"), (1, "unexpected }".into()));
    let (line, msg) = err("= 5");
    assert_eq!(line, 1);
    assert!(msg.contains("expected a name"), "msg: {}", msg);
    let (line, msg) = err("node x=\n");
    assert_eq!(line, 1);
    assert!(msg.contains("expected a value"), "msg: {}", msg);
    assert_eq!(err("/* xx"), (1, "unclosed block comment".into()));
    let (line, msg) = err(r#"node "a\qb""#);
    assert_eq!(line, 1);
    assert!(msg.contains("unknown escape"), "msg: {}", msg);
    assert_eq!(err("node 5x"), (1, "malformed number".into()));
}

#[test]
fn parses_server_style_auth_blocks() {
    let props = parse_kdl(r#"auth user="ada" password="pw""#).unwrap();
    assert_eq!(
        props[0].props,
        [
            ("user".into(), Str("ada".into())),
            ("password".into(), Str("pw".into())),
        ]
    );
    let children = parse_kdl("auth {\n  user \"ada\"\n  password \"pw\"\n}").unwrap();
    let names: Vec<&str> = children[0]
        .children
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["user", "password"]);
    assert_eq!(children[0].children[0].args, [Str("ada".into())]);
}

#[test]
fn keyword_guard_rejects_junk_suffixes() {
    let (line, msg) = err("node #truexyz");
    assert_eq!(line, 1);
    assert!(msg.contains("malformed keyword"), "msg: {}", msg);
    let (line, msg) = err("node priority=#true5");
    assert_eq!(line, 1);
    assert!(msg.contains("malformed keyword"), "msg: {}", msg);
    let (line, msg) = err("node #nullish");
    assert_eq!(line, 1);
    assert!(msg.contains("malformed keyword"), "msg: {}", msg);
}

#[test]
fn keywords_still_accepted_at_every_legal_delimiter() {
    let doc = parse_kdl("node #true #false #null;\nother key=#true { child \"x\" }").unwrap();
    assert_eq!(doc[0].args, [Bool(true), Bool(false), Null]);
    assert_eq!(doc[1].props, [("key".into(), Bool(true))]);
}

#[test]
fn oversized_documents_fail_with_a_line_number() {
    let src = "a".repeat(MAX_SOURCE_BYTES + 1);
    let (line, msg) = err(&src);
    assert_eq!(line, 1);
    assert!(msg.contains("document exceeds"), "msg: {}", msg);
}

#[test]
fn too_many_nodes_fail_with_a_line_number() {
    let src = "a\n".repeat(MAX_NODES + 1);
    let (line, msg) = err(&src);
    assert_eq!(line, MAX_NODES + 1);
    assert!(msg.contains("too many nodes"), "msg: {}", msg);
}

#[test]
fn nesting_deeper_than_the_cap_fails_with_a_line_number() {
    let src = "a {".repeat(65);
    let (line, msg) = err(&src);
    assert_eq!(line, 1);
    assert!(msg.contains("nesting too deep"), "msg: {}", msg);
}
