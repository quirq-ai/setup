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
  { cmd: 'qq run "COMMAND"', what: "run a command from the repo root with the pinned toolchains first on PATH" },
];

export const NEEDS =
  "git and python3 3.11.4 or newer with its venv module (Debian/Ubuntu: python3-venv). Toolchains are fetched for " +
  "Linux x86_64 only: on a Mac, qq sync stops with \"no pin for platform\", so use git clone instead of qq fetch " +
  "and install the pinned Python 3.14.8 or Node 24 yourself.";

export const ACCESS =
  "To push branches to a repo and open pull requests from them, an owner adds you as a collaborator " +
  "(the repo's Settings > Collaborators) or to its org. Without that, fork it on GitHub and work on your fork.";

/** @param {string | null} repo  "owner/name", already checked */
export function fetchLine(repo) {
  return `qq fetch https://github.com/${repo ?? "OWNER/NAME"}`;
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
  const parts = b.repo.split("/");
  if (parts.length !== 2 || !parts.every(isName)) return { ok: false, error: "repo must be owner/name, like quirq-ai/innernet" };
  return { ok: true, repo: b.repo };
}

/** The terminal's text for the tools path. @param {string | null} repo @returns {string[]} */
export function toolsText(repo) {
  return [
    "Install qq on this machine. Run each command once:",
    ...INSTALL.flatMap((s, i) => [`  ${i + 1}. ${s.what}:`, `     ${s.cmd}`]),
    "",
    `Then get ${repo ?? "a repo that has infra/repo.toml"}:`,
    `     ${fetchLine(repo)}`,
    "",
    "Inside it:",
    ...USE.map((u) => `     ${u.cmd.padEnd(20)} ${u.what}`),
    "",
    `Needs ${NEEDS}`,
    "",
    ACCESS,
  ];
}
