// @ts-check
// What the form shows: the user's orgs and, per org, its repos with the qq kinds they fit.
// Read-only: every call here is a GET through gh (cli/gh.mjs).

import { detectKinds } from "./detect.mjs";
import { encodeRef, getAll, getJson, isName, GhError } from "./gh.mjs";

/**
 * qq's own repos in quirq-ai: the tools qq is made of (infra-config's 13 infra repos) and this
 * command. They are not set up through this form, so setup never offers them. Names compare in
 * lower case, as GitHub's do.
 */
export const QQ_OWN_REPOS = new Set(["qq", "sync", "recipes", "infra-config", "test-pipelines", "gate",
  "toolchains", "remote-build", "gardener", "rollers", "release", "installer", "perf", "setup"]);

/** At most this many repos per org are checked, newest push first. */
export const MAX_REPOS = 100;

/**
 * @typedef {{ login: string, role: string, usable: boolean, reason?: string }} Org
 * @typedef {{ name: string, visibility: string, archived: boolean, fork: boolean,
 *   defaultBranch: string, kinds: import("./detect.mjs").Kind[], onQq: boolean,
 *   usable: boolean, reason?: string, notes: string[] }} Repo
 */

/** @returns {Promise<Org[]>} */
export async function listOrgs() {
  const memberships = await getAll("user/memberships/orgs?state=active");
  return memberships
    .map((m) => {
      const login = String(m?.organization?.login ?? "");
      const role = String(m?.role ?? "");
      if (!isName(login)) return null;
      return role === "admin"
        ? { login, role, usable: true }
        : { login, role, usable: false, reason: "you are not an owner of this org" };
    })
    .filter(/** @returns {o is Org} */ (o) => o !== null)
    .sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * @param {string} org  already checked against listOrgs()
 * @returns {Promise<{ org: string, truncated: boolean, repos: Repo[] }>}
 */
export async function listRepos(org) {
  if (!isName(org)) throw new GhError(`not an org name: ${org}`);
  const all = await getAll(`orgs/${org}/repos?type=all&sort=pushed&direction=desc`, 1);
  const raw = all.slice(0, MAX_REPOS).filter((r) => isName(r?.name));
  const repos = await mapLimit(raw, 8, async (r) => {
    try {
      return await describeRepo(org, r);
    } catch (e) {
      const reason = `could not read it: ${e instanceof Error ? e.message : String(e)}`;
      return { name: String(r.name), visibility: String(r.visibility ?? "unknown"), archived: Boolean(r.archived),
        fork: Boolean(r.fork), defaultBranch: String(r.default_branch ?? "main"), kinds: [], onQq: false,
        usable: false, reason, notes: [] };
    }
  });
  return { org, truncated: all.length >= MAX_REPOS, repos };
}

/**
 * @param {string} org
 * @param {any} r  one item of GET /orgs/{org}/repos
 * @returns {Promise<Repo>}
 */
async function describeRepo(org, r) {
  const base = {
    name: String(r.name),
    visibility: String(r.visibility ?? (r.private ? "private" : "public")),
    archived: Boolean(r.archived),
    fork: Boolean(r.fork),
    defaultBranch: String(r.default_branch ?? "main"),
  };
  if (org.toLowerCase() === "quirq-ai" && QQ_OWN_REPOS.has(base.name.toLowerCase())) {
    return { ...base, kinds: [], onQq: false, usable: false, notes: [],
      reason: "part of qq itself: qq's own tool repos are not set up through this form" };
  }
  if (base.archived) return { ...base, kinds: [], onQq: false, usable: false, reason: "archived", notes: [] };
  if (base.visibility !== "public") {
    return { ...base, kinds: [], onQq: false, usable: false, notes: [],
      reason: "private: GitHub offers a merge queue on private repos only on Enterprise Cloud, so qq v0 sets up public repos only" };
  }

  /** @type {string[]} */
  let rootNames;
  try {
    const root = await getJson(`repos/${org}/${base.name}/contents/?ref=${encodeRef(base.defaultBranch)}`);
    rootNames = Array.isArray(root) ? root.map((e) => String(e?.name ?? "")) : [];
  } catch (e) {
    if (e instanceof GhError && e.status === 404) {
      return { ...base, kinds: [], onQq: false, usable: false, reason: "empty repo", notes: [] };
    }
    throw e;
  }

  let pkg = null;
  if (rootNames.includes("package.json")) pkg = await readJsonFile(org, base.name, "package.json", base.defaultBranch);
  let requirementsDev = null;
  if (rootNames.includes("requirements-dev.txt")) requirementsDev = await readTextFile(org, base.name, "requirements-dev.txt", base.defaultBranch);
  let hasManifest = false;
  if (rootNames.includes("infra")) hasManifest = await exists(org, base.name, "infra/repo.toml", base.defaultBranch);

  const { kinds, onQq, notes } = detectKinds(rootNames, { packageJson: pkg, requirementsDev, hasManifest });
  return kinds.length
    ? { ...base, kinds, onQq, usable: true, notes }
    : { ...base, kinds, onQq, usable: false, reason: "no qq kind fits yet", notes };
}

/** @param {string} org @param {string} repo @param {string} path @param {string} ref @returns {Promise<string | null>} */
async function readTextFile(org, repo, path, ref) {
  try {
    const f = await getJson(`repos/${org}/${repo}/contents/${path}?ref=${encodeRef(ref)}`);
    if (f?.encoding !== "base64" || typeof f.content !== "string") return null;
    return Buffer.from(f.content, "base64").toString("utf8");
  } catch {
    return null; // unreadable: treated as absent, which yields a note, not a kind
  }
}

/** @param {string} org @param {string} repo @param {string} path @param {string} ref */
async function readJsonFile(org, repo, path, ref) {
  const text = await readTextFile(org, repo, path, ref);
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {string} org @param {string} repo @param {string} path @param {string} ref */
async function exists(org, repo, path, ref) {
  try {
    await getJson(`repos/${org}/${repo}/contents/${path}?ref=${encodeRef(ref)}`);
    return true;
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return false;
    throw e;
  }
}

/**
 * Map with at most `limit` calls in flight, keeping order.
 * @template T, U
 * @param {T[]} items @param {number} limit @param {(t: T) => Promise<U>} fn
 * @returns {Promise<U[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {U[]} */
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
