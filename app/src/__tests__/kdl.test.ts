import { describe, expect, it } from "vitest";
import { parseKdl } from "../kdl";

describe("parseKdl", () => {
  it("parses flat nodes with string args", () => {
    const doc = parseKdl('block "doubleclick.net"\nallow "example.com"');
    expect(doc.map((n) => n.name)).toEqual(["block", "allow"]);
    expect(doc[0].args).toEqual(["doubleclick.net"]);
    expect(doc[1].args).toEqual(["example.com"]);
  });

  it("parses scalars: numbers, keywords, barewords", () => {
    const doc = parseKdl("node 42 -7 3.5 2e3 0.5 #true #false #null bareword");
    expect(doc[0].args).toEqual([42, -7, 3.5, 2000, 0.5, true, false, null, "bareword"]);
  });

  it("parses props with string escapes", () => {
    const doc = parseKdl('node key="a \\"q\\" b" slash="\\/" nl="a\\nb" tab="\\t"');
    expect(doc[0].props).toEqual({ key: 'a "q" b', slash: "/", nl: "a\nb", tab: "\t" });
    expect(doc[0].args).toEqual([]);
  });

  it("parses children blocks and semicolons", () => {
    const doc = parseKdl('site "youtube.com" {\n  inject "/a.js";\n  block "ad.x"\n}');
    expect(doc[0].children.map((c) => c.name)).toEqual(["inject", "block"]);
    expect(doc[0].children[0].args).toEqual(["/a.js"]);
    const inline = parseKdl('a "x" { b "y"; c "z" }');
    expect(inline[0].children.map((c) => c.args[0])).toEqual(["y", "z"]);
  });

  it("skips line and block comments (nested)", () => {
    const doc = parseKdl('// line\n/* block\nstill /* nested */ ok */\nnode "v"');
    expect(doc).toHaveLength(1);
    expect(doc[0].args).toEqual(["v"]);
  });

  it("returns no nodes for empty or comment-only input", () => {
    expect(parseKdl("")).toEqual([]);
    expect(parseKdl("// only\n/* comments */")).toEqual([]);
  });

  it("throws with a line number on malformed input", () => {
    expect(() => parseKdl('block "oops')).toThrow(/line 1/);
    expect(() => parseKdl('a {\n b "x"\n')).toThrow(/line 3/);
    expect(() => parseKdl("}")).toThrow(/line 1/);
    expect(() => parseKdl("= 5")).toThrow(/line 1/);
    expect(() => parseKdl("node x=\n")).toThrow(/line 1/);
    expect(() => parseKdl("/* xx")).toThrow(/line 1/);
    expect(() => parseKdl('node "a\\qb"')).toThrow(/line 1/);
    expect(() => parseKdl("node 5x")).toThrow(/line 1/);
  });

  it("parses server-style auth blocks (props and children)", () => {
    const props = parseKdl('auth user="ada" password="pw"');
    expect(props[0].props).toEqual({ user: "ada", password: "pw" });
    const children = parseKdl('auth {\n  user "ada"\n  password "pw"\n}');
    expect(children[0].children.map((c) => c.name)).toEqual(["user", "password"]);
    expect(children[0].children[0].args).toEqual(["ada"]);
  });
});
