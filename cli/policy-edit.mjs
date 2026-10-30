// @ts-check
// Text edits to gate's settings/github.toml and pins.toml for step 3's writes. Pure: text in, text
// out. Each edit touches only the lines it must, keeps every other byte and comment, and is checked
// by parsing both sides: anything but the intended change throws, so a file this cannot edit safely
// is refused, never written half.

import { isDeepStrictEqual } from "node:util";
import { isName } from "./names.mjs";
import { parseToml } from "./toml.mjs";

export class EditError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "EditError";
  }
}

/**
 * The per-repo values the form edits. Others (checks, release, Dependabot) stay hand-written.
 * @typedef {{ approvals?: number, autoMerge?: boolean, codeOwnerReview?: boolean }} RepoFields
 */

const KEYS = /** @type {const} */ ({ approvals: "required_approvals", autoMerge: "allow_auto_merge", codeOwnerReview: "code_owner_review" });

/**
 * Check fields from the page: only known keys, approvals 0 to 10 (GitHub's range), booleans.
 * @param {unknown} f
 * @returns {RepoFields}
 */
export function checkFields(f) {
  if (f === undefined) return {};
  if (typeof f !== "object" || f === null || Array.isArray(f)) throw new EditError("fields must be an object");
  /** @type {RepoFields} */
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (k === "approvals") {
      if (!Number.isInteger(v) || /** @type {number} */ (v) < 0 || /** @type {number} */ (v) > 10) {
        throw new EditError("required approvals must be a whole number from 0 to 10");
      }
      out.approvals = /** @type {number} */ (v);
    } else if (k === "autoMerge" || k === "codeOwnerReview") {
      if (typeof v !== "boolean") throw new EditError(`${k} must be true or false`);
      out[k] = v;
    } else throw new EditError(`unknown field ${k}`);
  }
  return out;
}

/** @param {string} line */
const isHeader = (line) => /^\s*\[/.test(line);
/** @param {string} line */
const isLoose = (line) => /^\s*(#.*)?$/.test(line);

/**
 * Every `[[repo]]` block: its first line and the line after its last, leaving out the blank and
 * comment lines that lead into the next header (they belong to what follows).
 * @param {string[]} lines
 * @returns {{ start: number, end: number, name: string | null }[]}
 */
function repoBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[\[\s*repo\s*\]\]\s*(#.*)?$/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end])) end++;
    while (end > i + 1 && isLoose(lines[end - 1])) end--;
    const block = parseToml(lines.slice(i + 1, end).join("\n"));
    out.push({ start: i, end, name: typeof block.name === "string" ? block.name : null });
  }
  return out;
}

/** @param {string} text */
function split(text) {
  if (text.includes("\r")) throw new EditError("the file has Windows line endings; refusing to edit it");
  return text.split("\n");
}

/** @param {unknown} v */
function tomlValue(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  throw new EditError(`cannot write ${String(v)}`);
}

/**
 * The parsed file with one repo entry taken out, and that entry.
 * @param {any} data @param {string} name
 */
function without(data, name) {
  const repos = /** @type {any[]} */ (data.repo ?? []);
  const entry = repos.find((r) => r.name === name);
  return { rest: { ...data, repo: repos.filter((r) => r.name !== name) }, entry, at: repos.indexOf(entry) };
}

/** @param {string} what @param {boolean} ok */
function must(what, ok) {
  if (!ok) throw new EditError(`the edit changed more than ${what}; refusing it`);
}

/**
 * Set some of a gated repo's values in place. A changed line loses its trailing comment, which
 * explained the old value; the review shows that.
 * @param {string} text  gate settings/github.toml
 * @param {string} name
 * @param {RepoFields} fields
 * @returns {string}
 */
export function editRepo(text, name, fields) {
  const lines = split(text);
  const blocks = repoBlocks(lines).filter((b) => b.name === name);
  if (blocks.length !== 1) throw new EditError(`${name} is ${blocks.length ? "listed twice" : "not listed"} in gate's settings`);
  const { start } = blocks[0];
  let { end } = blocks[0];
  for (const [field, key] of Object.entries(KEYS)) {
    const v = /** @type {Record<string, unknown>} */ (fields)[field];
    if (v === undefined) continue;
    const line = `${key} = ${tomlValue(v)}`;
    const at = lines.slice(start, end).findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (at >= 0) {
      const old = lines[start + at];
      // Unchanged values keep their line, comment and all.
      if (parseToml(old)[key] !== v) lines[start + at] = line;
    } else {
      // After `kind`, else after `name`: where the other blocks keep their values.
      const kind = lines.slice(start, end).findIndex((l) => /^\s*kind\s*=/.test(l));
      const nameAt = lines.slice(start, end).findIndex((l) => /^\s*name\s*=/.test(l));
      const after = start + (kind >= 0 ? kind : nameAt);
      lines.splice(after + 1, 0, line);
      end++;
    }
  }
  const out = lines.join("\n");
  const before = without(parseToml(text), name);
  const after = without(parseToml(out), name);
  must(`${name}'s values`, isDeepStrictEqual(before.rest, after.rest) && before.at === after.at);
  /** @type {Record<string, unknown>} */
  const want = { ...before.entry };
  for (const [field, key] of Object.entries(KEYS)) {
    const v = /** @type {Record<string, unknown>} */ (fields)[field];
    if (v !== undefined) want[key] = v;
  }
  must(`${name}'s values`, isDeepStrictEqual(after.entry, want));
  return out;
}

/**
 * Add a product repo's block after the last product block, with the values gate's docs ask every
 * product to state ("Adding a product repo"): approvals, auto-merge, no transitional checks, and
 * Dependabot branches off until a roller lands them.
 * @param {string} text
 * @param {string} name
 * @param {Required<Pick<RepoFields, "approvals" | "autoMerge">> & RepoFields} fields
 * @returns {string}
 */
export function addProduct(text, name, fields) {
  if (!isName(name)) throw new EditError(`not a repo name: ${name}`);
  const lines = split(text);
  const blocks = repoBlocks(lines);
  if (blocks.some((b) => b.name === name)) throw new EditError(`${name} is already in gate's settings`);
  const data = parseToml(text);
  const products = blocks.filter((b) => /** @type {any[]} */ (data.repo).find((r) => r.name === b.name)?.kind === "product");
  if (!products.length) throw new EditError("gate's settings list no product repo to add this one after");
  const last = products[products.length - 1];
  const block = [
    "",
    "[[repo]]",
    `name = "${name}"`,
    `allow_auto_merge = ${fields.autoMerge}`,
    'kind = "product"',
    `required_approvals = ${fields.approvals}`,
    ...(fields.codeOwnerReview ? ["code_owner_review = true"] : []),
    "transitional_checks = []",
    "dependabot_branches = false           # added with qq-setup; Dependabot rolls are a later, reviewed change",
  ];
  lines.splice(last.end, 0, ...block);
  const out = lines.join("\n");
  const before = /** @type {any} */ (data);
  const after = /** @type {any} */ (parseToml(out));
  const at = before.repo.indexOf(before.repo.find((/** @type {any} */ r) => r.name === last.name)) + 1;
  /** @type {Record<string, unknown>} */
  const entry = { name, allow_auto_merge: fields.autoMerge, kind: "product", required_approvals: fields.approvals,
    transitional_checks: [], dependabot_branches: false };
  if (fields.codeOwnerReview) entry.code_owner_review = true;
  const want = { ...before, repo: [...before.repo.slice(0, at), entry, ...before.repo.slice(at)] };
  must(`one new [[repo]] for ${name}`, isDeepStrictEqual(after, want));
  return out;
}

/**
 * Where else gate's settings name a repo. Removing one of those is a policy change of its own (a
 * release executor's bypass, a pinned org workflow), so a repo named there is refused, as qqcfg
 * remove-repo refuses a repo another area names.
 * @param {any} data @param {string} name
 * @returns {string[]}
 */
export function otherUses(data, name) {
  const out = [];
  if ((data.release_refs?.executor_repos ?? []).includes(name)) out.push("[release_refs] executor_repos");
  for (const w of data.org_workflows ?? []) {
    if (Array.isArray(w.targets) && w.targets.includes(name)) out.push(`[[org_workflows]] ${w.ruleset}`);
  }
  return out;
}

/**
 * Take a repo's block out (and the blank line before it).
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
export function removeRepo(text, name) {
  const lines = split(text);
  const blocks = repoBlocks(lines).filter((b) => b.name === name);
  if (blocks.length !== 1) throw new EditError(`${name} is ${blocks.length ? "listed twice" : "not listed"} in gate's settings`);
  const data = /** @type {any} */ (parseToml(text));
  const uses = otherUses(data, name);
  if (uses.length) {
    throw new EditError(`gate's settings also name ${name} in ${uses.join(" and ")}; taking it out there is a ` +
      "policy change of its own, made by hand in a reviewed gate pull request first");
  }
  let { start } = blocks[0];
  const { end } = blocks[0];
  // A comment written right above the block is about it: it goes too.
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
  if (start > 0 && lines[start - 1].trim() === "") start--;
  lines.splice(start, end - start);
  const out = lines.join("\n");
  const before = without(data, name);
  must(`${name}'s block`, isDeepStrictEqual(before.rest, parseToml(out)));
  return out;
}

/**
 * Move gate's infra-config pin.
 * @param {string} text  gate pins.toml
 * @param {string} sha  40-hex infra-config commit
 * @param {string} why  the comment for the line
 * @returns {string}
 */
export function repin(text, sha, why) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new EditError(`not a commit id: ${sha}`);
  if (/[\n#]/.test(why)) throw new EditError("the pin's comment must be one line with no #");
  const lines = split(text);
  const head = lines.findIndex((l) => /^\s*\[infra-config\]\s*(#.*)?$/.test(l));
  if (head < 0) throw new EditError("pins.toml has no [infra-config]");
  let i = head + 1;
  while (i < lines.length && !isHeader(lines[i]) && !/^\s*commit\s*=/.test(lines[i])) i++;
  if (i >= lines.length || isHeader(lines[i])) throw new EditError("pins.toml [infra-config] has no commit");
  lines[i] = `commit = "${sha}"   # ${why}`;
  const out = lines.join("\n");
  const before = /** @type {any} */ (parseToml(text));
  const after = /** @type {any} */ (parseToml(out));
  must("the infra-config commit", isDeepStrictEqual(after, { ...before, "infra-config": { ...before["infra-config"], commit: sha } }));
  return out;
}
