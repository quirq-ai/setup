// @ts-check
// Step 3 of the form: quirq-ai's repos and the pipelines and policies each one is set up with, read
// from the files that own them (gate settings/github.toml, infra-config config/repos.toml and
// config/pipelines.toml, each repo's CODEOWNERS) and from GitHub's live rulesets. GETs only.
// This step shows where each value lives and whether GitHub matches it; cli/policy-write.mjs turns
// an add, edit or remove into pull requests.

import { encodeRef, getJson, GhError, isName } from "./gh.mjs";
import { mapLimit } from "./facts.mjs";
import { parseToml } from "./toml.mjs";

/** The org whose repos are configured from infra-config and gate, not from a qq-config of its own. */
export const POLICY_ORG = "quirq-ai";

/** Where each part comes from. Only these files are read; the page never names a path. */
export const SOURCES = /** @type {const} */ ({
  gate: { repo: "gate", path: "settings/github.toml" },
  repos: { repo: "infra-config", path: "config/repos.toml" },
  pipelines: { repo: "infra-config", path: "config/pipelines.toml" },
  org: { repo: "infra-config", path: "config/org.toml" },
  kinds: { repo: "infra-config", path: "config/kinds.toml" },
});

/** Where GitHub looks for CODEOWNERS, in its order. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * @typedef {{ name: string, pipeline: string, triggers: string[], blocking: boolean, generated: boolean }} Pipeline
 * @typedef {{ pattern: string, owners: string[] }} OwnerRule
 * @typedef {"applied" | "missing" | "unknown"} Applied
 * @typedef {{
 *   name: string,
 *   kind: "product" | "infra" | "unlisted",
 *   gated: boolean,
 *   kinds: string[],
 *   channels: string[],
 *   deploy: string | null,
 *   pipelines: Pipeline[],
 *   merge: null | { approvals: number, autoMerge: boolean | null, codeOwnerReview: boolean, checks: string[],
 *     checksFrom: "settings" | "pipelines", extra: string[] },
 *   owners: null | { path: string, rules: OwnerRule[] } | { path: null, rules: [] },
 *   ownersError?: string,
 *   ruleset: Applied,
 *   rulesetNote?: string,
 *   notes: string[],
 * }} RepoPolicy
 * @typedef {{ name: string, capabilities: string[] }} Kind
 * @typedef {{ ok: true, org: string, ruleset: string, read: { file: string, url: string }[], repos: RepoPolicy[], kinds: Kind[] }
 *   | { ok: false, error: string }} Policies
 */

/**
 * Pure: the cards for every repo the registries name, before the per-repo reads.
 * @param {any} gate  parsed gate settings/github.toml
 * @param {any} repos  parsed infra-config config/repos.toml (the products)
 * @param {any} pipelines  parsed infra-config config/pipelines.toml
 * @param {any} [org]  parsed infra-config config/org.toml (its [[infra_repo]]s, as gate reads them)
 * @returns {RepoPolicy[]}
 */
export function policyCards(gate, repos, pipelines, org) {
  const main = gate?.main ?? {};
  const defaultApprovals = Number(main.required_approvals ?? 0);
  /** @type {Map<string, any>} */
  const gated = new Map();
  for (const r of list(gate?.repo)) if (typeof r?.name === "string") gated.set(r.name, r);
  /** @type {Map<string, any>} */
  const products = new Map();
  for (const r of list(repos?.repo)) if (typeof r?.name === "string") products.set(r.name, r);
  /** @type {Set<string>} */
  const infraRepos = new Set(list(org?.infra_repo).map((r) => r?.name).filter((n) => typeof n === "string"));
  const builders = list(pipelines?.builder).filter((b) => typeof b?.name === "string" && typeof b?.repo === "string");

  const names = [...new Set([...gated.keys(), ...products.keys(), ...infraRepos])];
  return names.map((name) => /** @returns {RepoPolicy} */ {
    const g = gated.get(name);
    const p = products.get(name);
    /** @type {Pipeline[]} */
    const mine = builders
      .filter((b) => b.repo === name)
      .map((b) => ({
        name: b.name,
        pipeline: String(b.pipeline ?? ""),
        triggers: list(b.triggers).map(String),
        blocking: b.blocking === true,
        generated: b.generate === true,
      }));
    /** @type {string[]} */
    const notes = [];
    /** @type {RepoPolicy["kind"]} */
    const kind = g ? (g.kind === "infra" ? "infra" : "product") : "unlisted";
    if (!g) {
      const where = p ? "repos.toml" : "org.toml [[infra_repo]]";
      notes.push(`registered in infra-config ${where}, but not behind the gate yet: gate settings/github.toml has no [[repo]] for it`);
    }
    if (g && g.kind !== "product" && g.kind !== "infra") notes.push(`gate settings give it kind ${JSON.stringify(g.kind)}, which is neither product nor infra; shown as a product`);
    if (g?.kind === "product" && !p) notes.push("gate lists it as a product, but infra-config repos.toml does not");
    if (g?.kind === "infra" && org && !infraRepos.has(name)) notes.push("gate lists it as an infra repo, but infra-config org.toml has no [[infra_repo]] for it");

    /** @type {RepoPolicy["merge"]} */
    let merge = null;
    if (g) {
      const fromPipelines = g.kind !== "infra";
      const checks = fromPipelines
        ? [...mine.filter((b) => b.blocking).map((b) => b.name), ...list(g.transitional_checks).map(String)]
        : list(g.checks).map(String);
      /** @type {string[]} */
      const extra = [];
      if (list(g.state_branches).length) extra.push(`state branches: ${list(g.state_branches).join(", ")}`);
      if (list(g.executor_branches).length) extra.push(`written only by the release executor: ${list(g.executor_branches).join(", ")}`);
      if (list(g.release_tags).length) extra.push(`locked tags: ${list(g.release_tags).join(", ")}`);
      if (typeof g.queue_group_size === "number") extra.push(`merge queue groups of ${g.queue_group_size}`);
      if (list(g.allow_conditional).length) extra.push(`may skip: ${list(g.allow_conditional).join(", ")}`);
      if (g.dependabot_branches === true) extra.push("Dependabot branch rules on");
      merge = {
        approvals: typeof g.required_approvals === "number" ? g.required_approvals : defaultApprovals,
        // gate writes allow_auto_merge only when the key is there; without it GitHub keeps its own setting.
        autoMerge: typeof g.allow_auto_merge === "boolean" ? g.allow_auto_merge : null,
        codeOwnerReview: g.code_owner_review === true,
        checks,
        checksFrom: fromPipelines ? "pipelines" : "settings",
        extra,
      };
    }
    return {
      name,
      kind,
      gated: !!g,
      kinds: list(p?.kinds).map(String),
      channels: list(p?.channels).map(String),
      deploy: typeof p?.deploy?.target === "string" ? p.deploy.target : null,
      pipelines: mine,
      merge,
      owners: null,
      ruleset: /** @type {Applied} */ ("unknown"),
      notes,
    };
  }).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

/** Products first, then repos not behind the gate yet, then infra. @param {RepoPolicy} r */
function order(r) {
  return r.kind === "product" ? 0 : r.kind === "unlisted" ? 1 : 2;
}

/** @param {unknown} x @returns {any[]} */
function list(x) {
  return Array.isArray(x) ? x : [];
}

/**
 * Pure: a CODEOWNERS file's rules, in file order (the last match wins on GitHub).
 * @param {string} text
 * @returns {OwnerRule[]}
 */
export function parseCodeowners(text) {
  /** @type {OwnerRule[]} */
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Pure: whether the repo's rulesets include the gate's main ruleset.
 * @param {unknown} rulesets  GET /repos/{org}/{repo}/rulesets, or an Error
 * @param {string} name
 * @returns {{ ruleset: Applied, rulesetNote?: string }}
 */
export function rulesetState(rulesets, name) {
  if (!Array.isArray(rulesets)) {
    const why = rulesets instanceof Error ? rulesets.message : "unexpected answer";
    return { ruleset: "unknown", rulesetNote: `could not read its rulesets: ${why}` };
  }
  const found = rulesets.find((r) => r?.name === name);
  if (!found) return { ruleset: "missing" };
  if (found.enforcement && found.enforcement !== "active") return { ruleset: "missing", rulesetNote: `${name} is there but ${found.enforcement}` };
  return { ruleset: "applied" };
}

/**
 * Read one file on a repo's default branch through the contents API. null when it is not there.
 * @param {string} repo @param {string} path @param {string} [ref]
 * @returns {Promise<string | null>}
 */
async function readFile(repo, path, ref = "main") {
  try {
    const f = await getJson(`repos/${POLICY_ORG}/${repo}/contents/${path}?ref=${encodeRef(ref)}`);
    if (f?.encoding !== "base64" || typeof f.content !== "string") throw new GhError(`${repo}/${path}: not a file`);
    return Buffer.from(f.content, "base64").toString("utf8");
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return null;
    throw e;
  }
}

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * The CODEOWNERS GitHub uses on the repo's default branch. A repo that cannot be read at all (not
 * there, or not visible to this login: GitHub answers both with a 404) is an error, never "no file".
 * @param {string} repo
 * @returns {Promise<{ owners: RepoPolicy["owners"], ownersError?: string }>}
 */
async function readOwners(repo) {
  let branch;
  try {
    const r = await getJson(`repos/${POLICY_ORG}/${repo}`);
    branch = typeof r?.default_branch === "string" ? r.default_branch : "main";
  } catch (e) {
    const reason = e instanceof GhError && e.status === 404 ? "the repo is not there, or not visible to your gh login" : why(e);
    return { owners: null, ownersError: `could not read CODEOWNERS: ${reason}` };
  }
  try {
    const texts = await Promise.all(CODEOWNERS_PATHS.map((path) => readFile(repo, path, branch)));
    const i = texts.findIndex((t) => t !== null);
    return { owners: i < 0 ? { path: null, rules: [] } : { path: CODEOWNERS_PATHS[i], rules: parseCodeowners(/** @type {string} */ (texts[i])) } };
  } catch (e) {
    return { owners: null, ownersError: `could not read CODEOWNERS: ${why(e)}` };
  }
}

/** @returns {Promise<Policies>} */
export async function readPolicies() {
  /** @type {Record<keyof typeof SOURCES, any>} */
  const parsed = /** @type {any} */ ({});
  const read = await Promise.all(
    Object.entries(SOURCES).map(async ([id, src]) => {
      try {
        const text = await readFile(src.repo, src.path);
        if (text === null) return `${POLICY_ORG}/${src.repo} has no ${src.path} on main`;
        parsed[/** @type {keyof typeof SOURCES} */ (id)] = parseToml(text);
        return null;
      } catch (e) {
        return `could not read ${src.repo}/${src.path}: ${why(e)}`;
      }
    }),
  );
  const failed = read.find((r) => r !== null);
  if (failed) return { ok: false, error: failed };
  const ruleset = typeof parsed.gate?.main?.ruleset === "string" ? parsed.gate.main.ruleset : "qq-main";
  const cards = policyCards(parsed.gate, parsed.repos, parsed.pipelines, parsed.org).filter((c) => isName(c.name));
  // Each repo starts up to five gh processes at once (rulesets, the repo, three CODEOWNERS paths).
  const repos = await mapLimit(cards, 4, async (card) => {
    const [rules, owners] = await Promise.all([
      getJson(`repos/${POLICY_ORG}/${card.name}/rulesets?includes_parents=true&per_page=100`).catch((e) => (e instanceof Error ? e : new Error(String(e)))),
      readOwners(card.name),
    ]);
    return { ...card, ...rulesetState(rules, ruleset), ...owners };
  });
  return {
    ok: true,
    org: POLICY_ORG,
    ruleset,
    read: Object.values(SOURCES).map((s) => ({ file: `${s.repo}/${s.path}`, url: `https://github.com/${POLICY_ORG}/${s.repo}/blob/main/${s.path}` })),
    repos,
    kinds: list(parsed.kinds?.kind).filter((k) => typeof k?.name === "string" && isName(k.name))
      .map((k) => ({ name: k.name, capabilities: list(k.capabilities).map(String) })),
  };
}
