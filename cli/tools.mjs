// @ts-check
// The second way in: put qq on this machine and work on a repo that already uses it. qq-setup only
// prints these commands; it runs none of them. They are copied from the qq guide
// (quirq-ai/docs content/docs/qq.mdx, "Use qq on your machine", at 5d9371c); change both together.

import { isName } from "./gh.mjs";

/** Each runs inside `( … )`, so it leaves the shell as it was, and each is safe to run again. */
export const INSTALL = [
  {
    what: "Install qq",
    cmd: "( set -e; mkdir -p ~/qq-tools; rm -rf ~/qq-tools/depot; git clone -q https://github.com/quirq-ai/depot ~/qq-tools/depot; ~/qq-tools/depot/bin/qq --version )",
  },
  {
    what: "Install qqsync",
    cmd: '( set -e; mkdir -p ~/qq-tools; rm -rf ~/qq-tools/qqsync; python3 -m venv ~/qq-tools/qqsync; ~/qq-tools/qqsync/bin/pip install -q --disable-pip-version-check "qqsync @ git+https://github.com/quirq-ai/sync@main"; ~/qq-tools/qqsync/bin/qqsync --version )',
  },
  {
    what: "Put both on your PATH (adds one line to ~/.bashrc for bash, ~/.zshrc otherwise; open a new terminal afterwards)",
    cmd: `( case "$SHELL" in */bash) rc=~/.bashrc ;; *) rc=~/.zshrc ;; esac; mkdir -p ~/qq-tools/bin && ln -sf ~/qq-tools/depot/bin/qq ~/qq-tools/qqsync/bin/qqsync ~/qq-tools/bin/ && { grep -qs 'qq-tools/bin:' "$rc" || printf '\\nexport PATH="$HOME/qq-tools/bin:$PATH"\\n' >> "$rc"; } && echo "qq-tools/bin is on PATH in $rc; open a new terminal" )`,
  },
];

/** What a person runs inside a repo that has infra/repo.toml. */
export const USE = [
  { cmd: "qq sync", what: "fetch the pinned toolchains and check their digests" },
  { cmd: "qq build [TARGET]", what: "install dependencies and build" },
  { cmd: "qq test [TARGET]", what: "build and test; results in .qq/out/results.json" },
  { cmd: 'qq run "COMMAND"', what: "run a command once, from the repo root, with the pinned toolchains first on PATH" },
];

/** qq build and qq test hand off to a recipe for the repo's qq kind; not every kind has one yet. */
export const USE_NOTE =
  "qq build and qq test work where qq has a local recipe for the repo's kind; the repo's infra/repo.toml says when it has none.";

export const NEEDS = "git and python3 3.11.4 or newer with its venv module (Debian/Ubuntu: python3-venv).";

/** One statement about macOS, shared with preflight so the terminal never says two things. */
export const MAC =
  "qq fetches toolchains for Linux x86_64 only, so on a Mac qq fetch, qq sync, qq build, qq test and qq run need " +
  "Linux x86_64 for now: clone with git and use the repo's pinned tools yourself (qqsync show infra/repo.toml lists them).";

/**
 * What to list inside the repo on this platform: nothing on a Mac, where those commands need Linux.
 * The page and the terminal both use this, so they always say the same thing.
 * @param {string} platform  process.platform
 */
export function commandsFor(platform) {
  return platform === "darwin" ? { use: [], useNote: null } : { use: USE, useNote: USE_NOTE };
}

export const ACCESS =
  "To push branches to a repo and open pull requests from them, an owner gives you Write access: the repo's " +
  "Settings > Collaborators & teams, or an org team with Write on it. Without that, fork it on GitHub and work on your fork.";

/**
 * The line that gets the repo: qq fetch, except on a Mac, where it stops after cloning.
 * @param {string | null} repo  "owner/name", already checked
 * @param {string} platform  process.platform
 */
export function getLine(repo, platform) {
  const url = `https://github.com/${repo ?? "OWNER/NAME"}`;
  return platform === "darwin" ? `git clone ${url}` : `qq fetch ${url}`;
}

/**
 * "owner/name", a pasted https://github.com/owner/name link, or either with a trailing ".git" or "/",
 * as "owner/name". Anything else comes back unchanged, for checkTools to refuse.
 * @param {string} v
 */
export function normalizeRepo(v) {
  return v.replace(/^ +| +$/g, "").replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/, "");
}

/**
 * Accept the form's "just the tools" answer: `{ mode: "tools", repo: "owner/name" | null }`.
 * @param {unknown} body
 * @returns {{ ok: true, repo: string | null } | { ok: false, error: string }}
 */
export function checkTools(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "expected a JSON object" };
  const b = /** @type {Record<string, unknown>} */ (body);
  const extra = Object.keys(b).filter((k) => !["mode", "repo"].includes(k));
  if (extra.length) return { ok: false, error: `unexpected field: ${extra[0]}` };
  if (b.mode !== "tools") return { ok: false, error: "mode must be tools" };
  if (b.repo === null || b.repo === undefined || b.repo === "") return { ok: true, repo: null };
  if (typeof b.repo !== "string") return { ok: false, error: "repo must be owner/name" };
  const repo = normalizeRepo(b.repo);
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts.every(isName)) return { ok: false, error: "repo must be owner/name, like quirq-ai/innernet" };
  return { ok: true, repo };
}

/** The terminal's text for the tools path. @param {string | null} repo @param {string} platform @returns {string[]} */
export function toolsText(repo, platform) {
  return [
    "Install qq on this machine. Run each command once:",
    ...INSTALL.flatMap((s, i) => [`  ${i + 1}. ${s.what}:`, `     ${s.cmd}`]),
    `Needs ${NEEDS}`,
    "",
    `Then get ${repo ?? "a repo that has infra/repo.toml"}:`,
    `     ${getLine(repo, platform)}`,
    ...(platform === "darwin" ? [MAC] : []),
    "",
    ...inside(platform),
    ...(commandsFor(platform).use.length ? [""] : []),
    ACCESS,
  ];
}

/** @param {string} platform @returns {string[]} */
function inside(platform) {
  const { use, useNote } = commandsFor(platform);
  if (!use.length) return [];
  return ["Inside it:", ...use.map((u) => `     ${u.cmd.padEnd(20)} ${u.what}`), ...(useNote ? [useNote] : [])];
}
