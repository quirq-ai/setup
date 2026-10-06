// @ts-check
// The form's answers, checked against what the command itself read from GitHub, and the plan they
// lead to. Pure functions: no I/O, so tests cover them directly.

import { isName } from "./gh.mjs";

/** The config repo qq creates in the user's org: their copy of quirq-ai/infra-config's role. */
export const CONFIG_REPO = "qq-config";

/** Starter templates offered in the form. */
export const STARTERS = /** @type {const} */ ({
  "node-app": "Next.js 16 app (pnpm, Node 24)",
  "python-service": "Python 3.14 service with pytest",
});

/**
 * @typedef {{ org: string, repos: string[], starter: null | { name: string, kind: keyof typeof STARTERS } }} Answers
 */

/**
 * Accept the form's JSON only when every name is one the command offered.
 * @param {unknown} body
 * @param {import("./facts.mjs").Org[]} orgs
 * @param {(org: string) => import("./facts.mjs").Repo[] | undefined} reposOf  repos already listed for an org
 * @returns {{ ok: true, answers: Answers } | { ok: false, error: string }}
 */
export function checkAnswers(body, orgs, reposOf) {
  if (!body || typeof body !== "object") return { ok: false, error: "expected a JSON object" };
  const b = /** @type {Record<string, unknown>} */ (body);
  const extra = Object.keys(b).filter((k) => !["org", "repos", "starter"].includes(k));
  if (extra.length) return { ok: false, error: `unexpected field: ${extra[0]}` };

  const org = orgs.find((o) => o.login === b.org);
  if (!org) return { ok: false, error: "pick one of your orgs" };
  if (!org.usable) return { ok: false, error: `${org.login}: ${org.reason}` };
  const listed = reposOf(org.login);
  if (!listed) return { ok: false, error: "the repo list for this org was not loaded" };

  if (!Array.isArray(b.repos) || b.repos.some((r) => typeof r !== "string")) {
    return { ok: false, error: "repos must be a list of names" };
  }
  const picked = [...new Set(/** @type {string[]} */ (b.repos))];
  for (const name of picked) {
    const repo = listed.find((r) => r.name === name);
    if (!repo) return { ok: false, error: `${name} is not a repo the form offered` };
    if (!repo.usable) return { ok: false, error: `${name}: ${repo.reason}` };
  }

  /** @type {Answers["starter"]} */
  let starter = null;
  if (b.starter !== null && b.starter !== undefined) {
    const s = /** @type {Record<string, unknown>} */ (b.starter);
    if (typeof s !== "object" || typeof s.name !== "string" || typeof s.kind !== "string") {
      return { ok: false, error: "starter needs a name and a kind" };
    }
    if (!isName(s.name)) return { ok: false, error: "starter name: letters, digits, '.', '_' and '-' only" };
    if (!(s.kind in STARTERS)) return { ok: false, error: "starter kind: pick one of the offered templates" };
    const taken = s.name.toLowerCase();
    if (taken === CONFIG_REPO || listed.some((r) => r.name.toLowerCase() === taken)) {
      return { ok: false, error: `${s.name} already exists in ${org.login}` };
    }
    starter = { name: s.name, kind: /** @type {keyof typeof STARTERS} */ (s.kind) };
  }

  if (!picked.length && !starter) return { ok: false, error: "pick at least one repo or a starter repo" };
  return { ok: true, answers: { org: org.login, repos: picked.sort(), starter } };
}

/**
 * What the full command will do with these answers, step by step. This build prints it and stops.
 * @param {Answers} a
 * @param {import("./facts.mjs").Repo[]} listed
 * @param {boolean} configExists  the org already has a qq-config repo
 * @returns {{ does: string[], later: string[] }}
 */
export function buildPlan(a, listed, configExists) {
  const o = a.org;
  /** @type {string[]} */
  const does = [];
  does.push(configExists
    ? `Update ${o}/${CONFIG_REPO}: register the repos below and regenerate their workflows`
    : `Create ${o}/${CONFIG_REPO} (public, Apache-2.0): your qq policy, your repos and their builders`);
  if (a.starter) {
    does.push(`Create ${o}/${a.starter.name} (public) from the ${STARTERS[a.starter.kind]} template, with infra/repo.toml`);
  }
  const names = [...a.repos, ...(a.starter ? [a.starter.name] : [])];
  for (const name of a.repos) {
    const r = listed.find((x) => x.name === name);
    const kinds = r ? r.kinds.join(", ") : "";
    does.push(`Open a pull request in ${o}/${name} (${kinds}): ${r?.onQq ? "keep its infra/repo.toml, add" : "add infra/repo.toml and"} the generated qq-${name}-*.yml workflows; merge it once its presubmit is green`);
  }
  for (const name of names) {
    does.push(`Protect ${o}/${name}'s default branch with the qq-main ruleset: merge queue, squash only, presubmit required, no bypass`);
  }
  does.push(`Read every repo back and print "gated <repo>" only for repos whose ruleset and workflows are in place`);

  const later = [
    "Watching main after each merge (gardener) and the last-known-good commit (release)",
    "The daily canary channel",
    "Dependency and toolchain update pull requests",
    "Private repos",
  ];
  return { does, later };
}
