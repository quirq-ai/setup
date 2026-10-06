// @ts-check
// Which qq kinds a repo fits. A kind is offered only when the repo can run that kind's stand-in
// commands in infra-config config/kinds.toml as they are (audit S6), so the first presubmit is not
// red for a reason setup could have seen:
//   python-service  pip install -r requirements.txt; compileall
//   pytest          pip install -r requirements-dev.txt; pytest   (so requirements-dev.txt names pytest)
//   node-app        pnpm install --frozen-lockfile; pnpm build; pnpm typecheck   (Next.js)
//   gatsby-site     pnpm install --frozen-lockfile; pnpm build; pnpm test
// Anything else is "no kind yet", with a note saying what is missing.

/** @typedef {"python-service" | "pytest" | "node-app" | "gatsby-site"} Kind */

export const KINDS = /** @type {const} */ ({
  "python-service": "Python service",
  pytest: "pytest tests",
  "node-app": "Next.js app",
  "gatsby-site": "Gatsby site",
});

/**
 * @param {string[]} rootNames  file and directory names at the repo root
 * @param {{ packageJson?: any, requirementsDev?: string | null, hasManifest?: boolean }} files
 *   packageJson: parsed package.json (null when absent or unreadable); requirementsDev: the text of
 *   requirements-dev.txt; hasManifest: infra/repo.toml exists
 * @returns {{ kinds: Kind[], onQq: boolean, notes: string[] }}
 */
export function detectKinds(rootNames, files = {}) {
  const names = new Set(rootNames);
  /** @type {Kind[]} */
  const kinds = [];
  /** @type {string[]} */
  const notes = [];

  if (names.has("requirements.txt")) kinds.push("python-service");
  if (names.has("requirements-dev.txt")) {
    if (/^\s*pytest\b/im.test(files.requirementsDev ?? "")) kinds.push("pytest");
    else notes.push("requirements-dev.txt does not list pytest");
  }
  if (!names.has("requirements.txt") && !names.has("requirements-dev.txt") &&
      (names.has("pyproject.toml") || names.has("setup.py"))) {
    notes.push("Python without requirements.txt: qq's Python kinds install from requirements files");
  }

  const pkg = files.packageJson;
  if (names.has("package.json") && !(pkg && typeof pkg === "object")) {
    notes.push("package.json could not be read (too large or not valid JSON)");
  }
  if (pkg && typeof pkg === "object") {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const pnpm = names.has("pnpm-lock.yaml");
    /** @param {Kind} kind @param {string} what @param {string[]} need */
    const node = (kind, what, need) => {
      const missing = [...(pnpm ? [] : ["pnpm-lock.yaml"]), ...need.filter((s) => typeof scripts[s] !== "string").map((s) => `a "${s}" script`)];
      if (missing.length) notes.push(`${what} needs ${missing.join(" and ")} for qq's ${kind} kind`);
      else kinds.push(kind);
    };
    if ("next" in deps) node("node-app", "Next.js", ["build", "typecheck"]);
    else if ("gatsby" in deps) node("gatsby-site", "Gatsby", ["build", "test"]);
    else notes.push("Node project that is neither Next.js nor Gatsby: no qq kind yet");
  }

  return { kinds, onQq: !!files.hasManifest, notes };
}
