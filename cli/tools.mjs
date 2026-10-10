// @ts-check
// The second way in: put qq on this machine and work on a repo that already uses it. qq-setup only
// prints these commands; it runs none of them. They are copied from the qq guide
// (quirq-ai/docs content/docs/qq.mdx, "Use qq on your machine", at bb9a832); change both together,
// with tests/fixtures/qq-guide-install.txt.

import { isBlankRepo, parseRepo } from "./names.mjs";

/** Each runs inside `( … )`, so it leaves the shell as it was, and each is safe to run again. */
export const INSTALL = [
  {
    what: "Install qq",
    cmd: "( set -e; mkdir -p ~/qq-tools; rm -rf ~/qq-tools/depot; git clone -q https://github.com/quirq-ai/qq ~/qq-tools/depot; ~/qq-tools/depot/bin/qq --version )",
  },
  {
    what: "Install qqsync (pinned to the sync commit qq itself pins)",
    cmd: "( set -e; mkdir -p ~/qq-tools; rm -rf ~/qq-tools/qqsync; python3 -m venv ~/qq-tools/qqsync; ~/qq-tools/qqsync/bin/pip install -q --disable-pip-version-check \"qqsync @ git+https://github.com/quirq-ai/sync@aecb0fdb89f0d88b61a26052f5b3c26c48392841\"; ~/qq-tools/qqsync/bin/qqsync --version )",
  },
  {
    what: "Put both on your PATH (adds one line to ~/.bashrc for bash, to ~/.zshrc otherwise, and on a Mac to the first of ~/.bash_profile, ~/.bash_login or ~/.profile that bash already reads; open a new terminal afterwards)",
    cmd: "( case \"$SHELL:$(uname)\" in */bash:Darwin) for rc in ~/.bash_profile ~/.bash_login ~/.profile ~/.bash_profile; do [ -f \"$rc\" ] && break; done ;; */bash:*) rc=~/.bashrc ;; *) rc=~/.zshrc ;; esac; mkdir -p ~/qq-tools/bin && ln -sf ~/qq-tools/depot/bin/qq ~/qq-tools/qqsync/bin/qqsync ~/qq-tools/bin/ && { grep -qs 'qq-tools/bin:' \"$rc\" || printf '\\nexport PATH=\"$HOME/qq-tools/bin:$PATH\"\\n' >> \"$rc\"; } && echo \"qq-tools/bin is on PATH in $rc; open a new terminal\" )",
  },
];

/** What a person runs inside a repo that has infra/repo.toml. */
export const USE = [
  { cmd: "qq sync", what: "fetch the pinned toolchains and check their digests" },
  { cmd: "qq build [TARGET]", what: "install dependencies and build" },
  { cmd: "qq test [TARGET]", what: "build and test; results in .qq/out/results.json" },
  { cmd: 'qq run "COMMAND"', what: "run a command once, from the repo root, with the pinned toolchains first on PATH" },
];

/** On a Mac: no qq sync (it stops), and qq run uses PATH. */
export const USE_MAC = [
  { cmd: "qq build [TARGET]", what: "install dependencies and build, with the tools you installed" },
  { cmd: "qq test [TARGET]", what: "build and test; results in .qq/out/results.json" },
  { cmd: 'qq run "COMMAND"', what: "run a command once, from the repo root, with the tools on your PATH" },
];

/** qq build and qq test hand off to a recipe for the repo's qq kind; not every kind has one yet. */
export const USE_NOTE =
  "qq build and qq test work where qq has a local recipe for the repo's kind; the repo's infra/repo.toml says when it has none.";

export const NEEDS = "git and python3 3.11.4 or newer with its venv module (Debian/Ubuntu: python3-venv).";

/** One statement about macOS, shared with preflight, the page and the README (a test keeps them equal). */
export const MAC =
  "qq fetches toolchains for Linux x86_64 only, so on a Mac qq fetch clones the repo and then stops with " +
  "\"no pin for platform\", and qq sync stops the same way: clone with git and install the repo's pinned tools " +
  "yourself (qqsync show infra/repo.toml lists them). qq build and qq test then use them, from " +
  "--toolchain NAME=ROOT or your PATH, and still check the pinned versions (exact Python, Node major); " +
  "qq run uses your PATH.";

/**
 * What to list inside the repo on this platform. The page and the terminal both use this, so they
 * always say the same thing.
 * @param {string} platform  process.platform
 */
export function commandsFor(platform) {
  return { use: platform === "darwin" ? USE_MAC : USE, useNote: USE_NOTE };
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
  if (b.repo === null || b.repo === undefined) return { ok: true, repo: null };
  if (typeof b.repo !== "string") return { ok: false, error: "repo must be owner/name" };
  if (isBlankRepo(b.repo)) return { ok: true, repo: null };
  const repo = parseRepo(b.repo);
  if (!repo) return { ok: false, error: "repo must be owner/name, like quirq-ai/innernet" };
  return { ok: true, repo };
}

/** The terminal's text for the tools path. @param {string | null} repo @param {string} platform @returns {string[]} */
export function toolsText(repo, platform) {
  const { use, useNote } = commandsFor(platform);
  return [
    "Install qq on this machine. Run each command once:",
    ...INSTALL.flatMap((s, i) => [`  ${i + 1}. ${s.what}:`, `     ${s.cmd}`]),
    `Needs ${NEEDS}`,
    "",
    `Then get ${repo ?? "a repo that has infra/repo.toml"}:`,
    `     ${getLine(repo, platform)}`,
    ...(platform === "darwin" ? [MAC] : []),
    "",
    "Inside it:",
    ...use.map((u) => `     ${u.cmd.padEnd(20)} ${u.what}`),
    useNote,
    "",
    ACCESS,
  ];
}
