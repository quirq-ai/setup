// @ts-check
// Every GitHub call goes through the user's own `gh` login: this command never reads, stores or
// prints the token, because gh makes the HTTP request itself. This build only reads (GET).

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
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function gh(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { env: ghEnv(), timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = /** @type {NodeJS.ErrnoException & { code?: unknown }} */ (err);
          if (e.code === "ENOENT") return reject(new GhError("gh (GitHub CLI) is not installed: https://cli.github.com"));
          const status = /HTTP (\d{3})/.exec(String(stderr))?.[1];
          const line = String(stderr).trim().split("\n").filter(Boolean).pop() ?? e.message;
          return reject(new GhError(`gh ${args[0]} failed: ${line}`, status ? Number(status) : null));
        }
        resolve(String(stdout));
      },
    );
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
 * GET every page of a list endpoint (gh joins the pages).
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

/** GitHub's rule for org and repo names, plus a length cap. @param {unknown} s @returns {s is string} */
export function isName(s) {
  return typeof s === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(s) && !s.endsWith(".git");
}

/** Percent-encode a branch name for a query string, leaving only characters PATH_RE accepts. @param {string} ref */
export function encodeRef(ref) {
  return encodeURIComponent(ref).replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
