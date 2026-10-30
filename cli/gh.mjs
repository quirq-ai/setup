// @ts-check
// Every GitHub call goes through the user's own `gh` login: this command never reads, stores or
// prints the token, because gh makes the HTTP request itself. Reads are GETs; the only writes are
// `ghWrite`'s, which step 3 uses to open pull requests in quirq-ai (cli/policy-write.mjs).

import { execFile } from "node:child_process";

/** Variables that would make gh use a token other than the user's own login. */
export const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/** The environment gh runs with: never a token variable, never a pager or a prompt. */
export function ghEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = { ...env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  for (const v of TOKEN_VARS) delete out[v];
  delete out.GH_HOST; // always github.com
  return out;
}

export class GhError extends Error {
  /** @param {string} message @param {number | null} status */
  constructor(message, status = null) {
    super(message);
    this.name = "GhError";
    this.status = status;
  }
}

/**
 * Run gh with arguments (never a shell). Resolves with stdout.
 * @param {string[]} args
 * @param {{ timeoutMs?: number, input?: string }} [opts]  input: written to gh's stdin
 * @returns {Promise<string>}
 */
export function gh(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { env: ghEnv(), timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = /** @type {NodeJS.ErrnoException & { code?: unknown }} */ (err);
          if (e.code === "ENOENT") return reject(new GhError("gh (GitHub CLI) is not installed: https://cli.github.com"));
          // Logged out: gh exits 4 and its last line suggests GH_TOKEN, which this command refuses.
          if (/** @type {unknown} */ (e.code) === 4 || String(stderr).includes("gh auth login")) {
            return reject(new GhError("gh is not logged in: run  gh auth login", 401));
          }
          const status = /HTTP (\d{3})/.exec(String(stderr))?.[1];
          const line = String(stderr).trim().split("\n").filter(Boolean).pop() ?? e.message;
          return reject(new GhError(`gh ${args[0]} failed: ${line}`, status ? Number(status) : null));
        }
        resolve(String(stdout));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** A GitHub REST path we build ourselves from names checked by `isName` and refs run through `encodeRef`. */
const PATH_RE = /^[A-Za-z0-9._\/?=&%-]+$/;

/**
 * GET a REST path as JSON. Only GET: `gh api` would switch to POST if given fields, and we pass none.
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function getJson(path) {
  if (!PATH_RE.test(path) || path.includes("..")) throw new GhError(`refusing an unexpected API path: ${path}`);
  const out = await gh(["api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github+json", path]);
  return JSON.parse(out);
}

/**
 * GET every page of a list endpoint, one page of 100 at a time, up to maxPages.
 * @param {string} path
 * @param {number} maxPages
 * @returns {Promise<any[]>}
 */
export async function getAll(path, maxPages = 5) {
  /** @type {any[]} */
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await getJson(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new GhError(`expected a list from ${path}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/**
 * The scopes of the user's gh token, from the X-OAuth-Scopes header of GET /user.
 * null means the header is absent (a fine-grained or app token): scopes cannot be listed.
 * @returns {Promise<{ login: string, scopes: string[] | null }>}
 */
export async function whoami() {
  const out = await gh(["api", "--hostname", "github.com", "--method", "GET", "--include", "user"]);
  const split = out.indexOf("\r\n\r\n") >= 0 ? out.indexOf("\r\n\r\n") : out.indexOf("\n\n");
  const head = split >= 0 ? out.slice(0, split) : "";
  const body = split >= 0 ? out.slice(split).trim() : out;
  const m = /^x-oauth-scopes:\s*(.*)$/im.exec(head);
  const scopes = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
  return { login: JSON.parse(body).login, scopes };
}

export { isName } from "./names.mjs";

/** Percent-encode a branch name for a query string, leaving only characters PATH_RE accepts. @param {string} ref */
export function encodeRef(ref) {
  return encodeURIComponent(ref).replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The only writes this command makes, all in quirq-ai and all toward a pull request: a tree, a
 * commit, a new branch under qq-setup/, and the pull request. Never a merge, a ref update, a
 * delete, a setting or main. `ghWrite` refuses anything else before gh runs.
 */
const WRITES = [
  /^repos\/quirq-ai\/[A-Za-z0-9._-]+\/git\/trees$/,
  /^repos\/quirq-ai\/[A-Za-z0-9._-]+\/git\/commits$/,
  /^repos\/quirq-ai\/[A-Za-z0-9._-]+\/git\/refs$/,
  /^repos\/quirq-ai\/[A-Za-z0-9._-]+\/pulls$/,
];

/**
 * POST a JSON body (on stdin, so nothing lands in a process list) to one of WRITES.
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @returns {Promise<any>}
 */
export async function ghWrite(path, body) {
  if (!WRITES.some((re) => re.test(path)) || path.includes("..")) throw new GhError(`refusing to write to ${path}`);
  if (path.endsWith("/git/refs") && !(typeof body.ref === "string" && /^refs\/heads\/qq-setup\/[A-Za-z0-9._-]+$/.test(body.ref))) {
    throw new GhError("refusing to create a branch outside qq-setup/");
  }
  if (path.endsWith("/pulls") && !(typeof body.head === "string" && body.head.startsWith("qq-setup/"))) {
    throw new GhError("refusing a pull request from a branch outside qq-setup/");
  }
  const out = await gh(["api", "--hostname", "github.com", "--method", "POST", "-H", "Accept: application/vnd.github+json",
    path, "--input", "-"], { input: JSON.stringify(body), timeoutMs: 60_000 });
  return JSON.parse(out);
}
