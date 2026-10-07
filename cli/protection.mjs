// @ts-check
// What already guards each picked repo's default branch, read with GETs only, so the printed plan can
// warn before the setup step adds the qq-main ruleset (audit B1, setup #1 audit S2). Rulesets and
// classic protection stack and the strictest rule wins, so an old required check that never runs on
// merge_group would stall the merge queue; that is what these warnings are for.

import { encodeRef, getJson, GhError } from "./gh.mjs";

/**
 * @typedef {{ squash: boolean | null, rulesets: string[] | null,
 *   classic: null | "none" | "unreadable" | { checks: string[], reviews: number } }} Protection
 */

/**
 * Read one repo's merge setting, rulesets and classic protection. Every failure becomes "unknown",
 * never "none".
 * @param {string} org @param {string} repo @param {string} branch
 * @returns {Promise<Protection>}
 */
export async function readProtection(org, repo, branch) {
  /** @type {Protection} */
  const p = { squash: null, rulesets: null, classic: null };
  try {
    const r = await getJson(`repos/${org}/${repo}`);
    if (typeof r?.allow_squash_merge === "boolean") p.squash = r.allow_squash_merge;
  } catch {
    // stays null: reported as not checked
  }
  try {
    const list = await getJson(`repos/${org}/${repo}/rulesets?includes_parents=true`);
    if (Array.isArray(list)) p.rulesets = list.map((x) => String(x?.name ?? "")).filter(Boolean);
  } catch {
    // stays null
  }
  try {
    const c = await getJson(`repos/${org}/${repo}/branches/${encodeRef(branch)}/protection`);
    const checks = [
      ...(c?.required_status_checks?.contexts ?? []),
      ...(c?.required_status_checks?.checks ?? []).map((/** @type {any} */ x) => x?.context),
    ].filter((x) => typeof x === "string");
    p.classic = { checks: [...new Set(checks)], reviews: Number(c?.required_pull_request_reviews?.required_approving_review_count ?? 0) };
  } catch (e) {
    // 404 "Branch not protected" means none; 403 means the reader is not a repo admin.
    p.classic = e instanceof GhError && e.status === 404 ? "none" : "unreadable";
  }
  return p;
}

/**
 * Pure: the warnings for one repo, or an empty list when nothing stands in the way.
 * @param {string} branch @param {Protection} p
 * @returns {string[]}
 */
export function protectionWarnings(branch, p) {
  /** @type {string[]} */
  const w = [];
  if (p.squash === false) w.push("squash merging is off; qq-main lands with squash, so setup would stop here");
  if (p.squash === null) w.push("could not read the merge settings");
  if (p.rulesets === null) w.push("could not read its rulesets");
  else {
    const other = p.rulesets.filter((n) => !n.startsWith("qq-"));
    if (other.length) w.push(`other rulesets apply (${other.join(", ")}); they stack with qq-main and the strictest rule wins`);
  }
  if (p.classic === "unreadable") w.push(`could not read ${branch}'s branch protection (that needs admin on the repo)`);
  else if (p.classic && p.classic !== "none") {
    w.push(`${branch} has classic branch protection, which stays in force next to qq-main`);
    if (p.classic.checks.length) {
      w.push(`its required checks (${p.classic.checks.join(", ")}) must also run on merge_group, or the merge queue stalls`);
    }
    if (p.classic.reviews > 0) {
      w.push(`it requires ${p.classic.reviews} approving review${p.classic.reviews > 1 ? "s" : ""}: setup would leave its pull request open for you`);
    }
  }
  return w;
}
