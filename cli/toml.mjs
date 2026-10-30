// @ts-check
// A reader for the small part of TOML that quirq-ai's settings files use (gate settings/github.toml,
// infra-config config/*.toml): tables, arrays of tables, dotted table names, and keys holding a
// string, a number, a boolean or an array of those (arrays may span lines). The package has no
// dependencies, so this is not a full TOML parser: anything outside that subset (inline tables,
// multi-line strings, dates, dotted or quoted keys) throws, so a file it cannot read is reported as
// unreadable, never read half.

/** @typedef {string | number | boolean | unknown[]} Value  an array holds Values */
/** @typedef {{ [key: string]: Value | Table | Table[] }} Table */

export class TomlError extends Error {
  /** @param {string} message @param {number} line 1-based */
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

const BARE = /^[A-Za-z0-9_-]+$/;
// Names that would reach Object.prototype through a plain object: refused, never followed.
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
// TOML numbers: no leading zero, and an underscore only between digits.
const DIGITS = String.raw`\d(?:_?\d)*`;
const NUMBER = new RegExp(String.raw`^([+-]?(?:0|[1-9](?:_?\d)*)(?:\.${DIGITS})?(?:[eE][+-]?${DIGITS})?|true|false)(?=[\s,\]]|$)`);

/** @param {string} key @param {number} n */
function checkKey(key, n) {
  if (!BARE.test(key) || RESERVED.has(key)) throw new TomlError(`unsupported key ${key}`, n);
}

/**
 * @param {string} text
 * @returns {Table}
 */
export function parseToml(text) {
  /** @type {Table} */
  const root = {};
  /** @type {Table} */
  let current = root;
  // Tables made only because a dotted header named them (`a` for `[a.b]`): `[a]` may still follow once.
  /** @type {WeakSet<Table>} */
  const implicit = new WeakSet();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = stripComment(lines[i], n).trim();
    if (!line) continue;
    let m;
    if ((m = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line))) {
      const path = tablePath(m[1], n);
      const parent = walk(root, path.slice(0, -1), n, implicit);
      const last = path[path.length - 1];
      const list = Object.hasOwn(parent, last) ? parent[last] : (parent[last] = []);
      if (!Array.isArray(list) || list.some((x) => !isTable(x))) throw new TomlError(`${m[1]} is not an array of tables`, n);
      /** @type {Table} */
      const t = {};
      /** @type {Table[]} */ (list).push(t);
      current = t;
      continue;
    }
    if ((m = /^\[\s*([^\]]+?)\s*\]$/.exec(line))) {
      const path = tablePath(m[1], n);
      const parent = walk(root, path.slice(0, -1), n, implicit);
      const last = path[path.length - 1];
      const before = Object.hasOwn(parent, last) ? parent[last] : undefined;
      if (before !== undefined && !(isTable(before) && implicit.has(before))) throw new TomlError(`table ${m[1]} defined twice`, n);
      /** @type {Table} */
      const t = before ?? {};
      implicit.delete(t);
      parent[last] = t;
      current = t;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw new TomlError("expected key = value", n);
    const key = line.slice(0, eq).trim();
    checkKey(key, n);
    if (Object.hasOwn(current, key)) throw new TomlError(`${key} set twice`, n);
    let rest = line.slice(eq + 1).trim();
    // An array may continue over the next lines until its brackets balance.
    while (rest.startsWith("[") && !balanced(rest)) {
      i++;
      if (i >= lines.length) throw new TomlError(`array for ${key} never closes`, n);
      rest += " " + stripComment(lines[i], i + 1).trim();
    }
    const { value, end } = readValue(rest, 0, n);
    if (rest.slice(end).trim()) throw new TomlError(`unexpected text after ${key}`, n);
    current[key] = value;
  }
  return root;
}

/** @param {unknown} x @returns {x is Table} */
function isTable(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** @param {string} name @param {number} n */
function tablePath(name, n) {
  const path = name.split(".").map((p) => p.trim());
  if (path.some((p) => !BARE.test(p) || RESERVED.has(p))) throw new TomlError(`unsupported table name ${name}`, n);
  return path;
}

/**
 * Follow a table path, into the last table of an array of tables, creating plain tables on the way
 * (marked implicit). Only own properties are followed.
 * @param {Table} root @param {string[]} path @param {number} n @param {WeakSet<Table>} implicit
 */
function walk(root, path, n, implicit) {
  let t = root;
  for (const p of path) {
    /** @type {unknown} */
    let next = Object.hasOwn(t, p) ? t[p] : undefined;
    if (next === undefined) {
      /** @type {Table} */
      const made = {};
      implicit.add(made);
      next = t[p] = made;
    }
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!isTable(next)) throw new TomlError(`${p} is not a table`, n);
    t = next;
  }
  return t;
}

/** Drop a trailing comment, leaving `#` inside strings alone. @param {string} line @param {number} n */
function stripComment(line, n) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) throw new TomlError("multi-line strings are not supported", n);
      quote = c;
    } else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** @param {string} s */
function balanced(s) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth === 0;
}

/**
 * @param {string} s @param {number} at @param {number} n
 * @returns {{ value: Value, end: number }}
 */
function readValue(s, at, n) {
  while (s[at] === " " || s[at] === "\t") at++;
  const c = s[at];
  if (c === '"') {
    let out = "";
    for (let i = at + 1; i < s.length; i++) {
      if (s[i] === '"') return { value: out, end: i + 1 };
      if (s[i] === "\\") {
        const e = s[++i];
        const map = /** @type {Record<string, string>} */ ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" });
        if (!(e in map)) throw new TomlError(`unsupported escape \\${e}`, n);
        out += map[e];
      } else out += s[i];
    }
    throw new TomlError("string never closes", n);
  }
  if (c === "'") {
    const close = s.indexOf("'", at + 1);
    if (close < 0) throw new TomlError("string never closes", n);
    return { value: s.slice(at + 1, close), end: close + 1 };
  }
  if (c === "[") {
    /** @type {Value[]} */
    const items = [];
    let i = at + 1;
    const space = () => {
      while (/\s/.test(s[i] ?? "")) i++;
    };
    for (;;) {
      // One value, then one comma or the end; a trailing comma before ] is allowed.
      space();
      if (s[i] === "]") return { value: items, end: i + 1 };
      if (i >= s.length) throw new TomlError("array never closes", n);
      if (s[i] === ",") throw new TomlError("comma with no value before it in array", n);
      const item = readValue(s, i, n);
      items.push(item.value);
      i = item.end;
      space();
      if (s[i] === ",") i++;
      else if (s[i] !== "]") throw new TomlError("expected , or ] in array", n);
    }
  }
  const m = NUMBER.exec(s.slice(at));
  if (!m) throw new TomlError(`unsupported value ${s.slice(at, at + 20)}`, n);
  const word = m[1];
  const value = word === "true" ? true : word === "false" ? false : Number(word.replace(/_/g, ""));
  return { value, end: at + word.length };
}
