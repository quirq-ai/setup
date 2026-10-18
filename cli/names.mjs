// @ts-check
// Names: pure functions with no Node imports, so the form imports this same file (one copy of the rules).

/** GitHub's rule for org and repo names, plus a length cap. @param {unknown} s @returns {s is string} */
export function isName(s) {
  return typeof s === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(s) && !/\.git$/i.test(s);
}
