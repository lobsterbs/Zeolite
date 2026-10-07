/* Minimal KDL v2-subset parser for the engine's data files
   (siteconfig.kdl, rules.kdl, the server --config file). Covers
   the grammar those files use: nodes with string/number/keyword
   args, name=value props, { children } blocks, semicolons, // and
   nested block comments. Unsupported KDL features (raw and
   multiline strings, line continuations) fail with a line number
   instead of being silently misparsed. */

export type KdlValue = string | number | boolean | null;

export interface KdlNode {
  name: string;
  args: KdlValue[];
  props: Record<string, KdlValue>;
  children: KdlNode[];
}

interface Cursor {
  src: string;
  pos: number;
  line: number;
}

function fail(c: Cursor, msg: string): never {
  throw new Error("kdl: line " + c.line + ": " + msg);
}

function peek(c: Cursor): string | undefined {
  return c.src[c.pos];
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "-")
  );
}

function isIdentChar(ch: string | undefined): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** Spaces, tabs and carriage returns (newlines terminate nodes). */
function skipInline(c: Cursor): void {
  while (peek(c) === " " || peek(c) === "\t" || peek(c) === "\r") c.pos++;
}

/** A block comment; KDL nests them. */
function skipBlockComment(c: Cursor): void {
  c.pos += 2;
  let depth = 1;
  while (depth > 0) {
    if (c.pos >= c.src.length) fail(c, "unclosed block comment");
    const ch = c.src[c.pos];
    if (ch === "/" && c.src[c.pos + 1] === "*") {
      depth++;
      c.pos += 2;
    } else if (ch === "*" && c.src[c.pos + 1] === "/") {
      depth--;
      c.pos += 2;
    } else {
      if (ch === "\n") c.line++;
      c.pos++;
    }
  }
}

/** In-line gaps: spaces plus block comments. Stops at newlines and
    line comments; both terminate the current node. */
function skipGap(c: Cursor): void {
  for (;;) {
    skipInline(c);
    if (peek(c) === "/" && c.src[c.pos + 1] === "*") skipBlockComment(c);
    else return;
  }
}

/** All whitespace and comments, newlines included. */
function skipSpace(c: Cursor): void {
  for (;;) {
    skipGap(c);
    if (peek(c) === "\n") {
      c.pos++;
      c.line++;
    } else if (peek(c) === "/" && c.src[c.pos + 1] === "/") {
      while (c.pos < c.src.length && c.src[c.pos] !== "\n") c.pos++;
    } else return;
  }
}

function parseIdent(c: Cursor): string {
  const ch = peek(c);
  if (!isIdentStart(ch)) {
    fail(c, "expected a name, got " + (ch === undefined ? "end of input" : JSON.stringify(ch)));
  }
  const start = c.pos;
  c.pos++;
  while (isIdentChar(peek(c))) c.pos++;
  return c.src.slice(start, c.pos);
}

function parseString(c: Cursor): string {
  c.pos++;
  let out = "";
  for (;;) {
    if (c.pos >= c.src.length || c.src[c.pos] === "\n") fail(c, "unclosed string");
    const ch = c.src[c.pos];
    if (ch === '"') {
      c.pos++;
      return out;
    }
    if (ch === "\\") {
      const esc = c.src[c.pos + 1];
      if (esc === undefined || esc === "\n") fail(c, "unclosed string");
      if (esc === '"') out += '"';
      else if (esc === "\\") out += "\\";
      else if (esc === "/") out += "/";
      else if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "r") out += "\r";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else fail(c, "unknown escape \\" + esc);
      c.pos += 2;
    } else {
      out += ch;
      c.pos++;
    }
  }
}

function parseNumber(c: Cursor): number {
  const start = c.pos;
  if (peek(c) === "-") c.pos++;
  while (isDigit(peek(c))) c.pos++;
  if (peek(c) === ".") {
    c.pos++;
    if (!isDigit(peek(c))) fail(c, "malformed number");
    while (isDigit(peek(c))) c.pos++;
  }
  if (peek(c) === "e" || peek(c) === "E") {
    const save = c.pos;
    c.pos++;
    if (peek(c) === "+" || peek(c) === "-") c.pos++;
    if (!isDigit(peek(c))) c.pos = save;
    else while (isDigit(peek(c))) c.pos++;
  }
  const n = Number(c.src.slice(start, c.pos));
  if (Number.isNaN(n)) fail(c, "malformed number");
  const after = peek(c);
  if (
    after !== undefined &&
    after !== " " &&
    after !== "\t" &&
    after !== "\r" &&
    after !== "\n" &&
    after !== ";" &&
    after !== "{" &&
    after !== "}" &&
    after !== "/" &&
    after !== "="
  ) {
    fail(c, "malformed number");
  }
  return n;
}

function parseValue(c: Cursor): KdlValue {
  const ch = peek(c);
  if (ch === '"') return parseString(c);
  if (ch === "#") {
    if (c.src.startsWith("#true", c.pos)) {
      c.pos += 5;
      return true;
    }
    if (c.src.startsWith("#false", c.pos)) {
      c.pos += 6;
      return false;
    }
    if (c.src.startsWith("#null", c.pos)) {
      c.pos += 5;
      return null;
    }
    fail(c, "unsupported # syntax (only #true #false #null)");
  }
  if (isDigit(ch) || (ch === "-" && isDigit(c.src[c.pos + 1]))) return parseNumber(c);
  if (isIdentStart(ch)) return parseIdent(c);
  fail(c, "expected a value, got " + (ch === undefined ? "end of input" : JSON.stringify(ch)));
}

function parseEntry(c: Cursor, node: KdlNode): void {
  const ch = peek(c);
  if (ch === '"') {
    node.args.push(parseString(c));
    return;
  }
  if (ch === "#") {
    node.args.push(parseValue(c));
    return;
  }
  if (isDigit(ch) || (ch === "-" && isDigit(c.src[c.pos + 1]))) {
    node.args.push(parseNumber(c));
    return;
  }
  if (!isIdentStart(ch)) fail(c, "unexpected character " + JSON.stringify(ch));
  const word = parseIdent(c);
  skipInline(c);
  if (peek(c) === "=") {
    c.pos++;
    skipInline(c);
    node.props[word] = parseValue(c);
  } else {
    node.args.push(word);
  }
}

function parseNode(c: Cursor): KdlNode {
  const node: KdlNode = { name: parseIdent(c), args: [], props: {}, children: [] };
  for (;;) {
    skipGap(c);
    const ch = peek(c);
    if (ch === undefined || ch === "\n") return node;
    if (ch === ";") {
      c.pos++;
      return node;
    }
    if (ch === "/" && c.src[c.pos + 1] === "/") return node;
    if (ch === "}") return node;
    if (ch === "{") {
      c.pos++;
      node.children = parseChildren(c);
      if (peek(c) !== "}") fail(c, "unclosed {");
      c.pos++;
      continue;
    }
    parseEntry(c, node);
  }
}

function parseChildren(c: Cursor): KdlNode[] {
  const nodes: KdlNode[] = [];
  for (;;) {
    skipSpace(c);
    const ch = peek(c);
    if (ch === undefined || ch === "}") return nodes;
    nodes.push(parseNode(c));
  }
}

/** Parse a KDL v2-subset document into nodes. Throws with a line
    number on malformed input; unsupported syntax fails loudly. */
export function parseKdl(source: string): KdlNode[] {
  const c: Cursor = { src: source, pos: 0, line: 1 };
  const nodes: KdlNode[] = [];
  for (;;) {
    skipSpace(c);
    const ch = peek(c);
    if (ch === undefined) return nodes;
    if (ch === "}") fail(c, "unexpected }");
    nodes.push(parseNode(c));
  }
}
