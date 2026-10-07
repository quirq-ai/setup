// @ts-check
// Names: pure functions with no Node imports, so the form imports this same file (one copy of the rules).

/** GitHub's rule for org and repo names, plus a length cap. @param {unknown} s @returns {s is string} */
export function isName(s) {
  return typeof s === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(s) && !/\.git$/i.test(s);
}

/**
 * "owner/name", a pasted https://github.com/owner/name link, or either with a trailing ".git" or "/",
 * as "owner/name". Only ASCII spaces around it are dropped; anything else stays, for parseRepo to refuse.
 * @param {string} v
 */
export function normalizeRepo(v) {
  return v.replace(/^ +| +$/g, "").replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
}

/** Blank means "no repo": empty, or ASCII spaces only. A tab or any other space is not blank. @param {string} v */
export function isBlankRepo(v) {
  return /^ *$/.test(v);
}

/** The owner/name a typed or pasted value names, or null. @param {string} v @returns {string | null} */
export function parseRepo(v) {
  const repo = normalizeRepo(v);
  const parts = repo.split("/");
  return parts.length === 2 && parts.every(isName) ? repo : null;
}
