// @ts-check
// qq's install commands, which `qq-setup install` and the page's "This machine" steps run (cli/install.mjs).
// They are copied from the qq guide
// (quirq-ai/docs content/docs/install.mdx, "Install qq", at 3f8df0d); change both together,
// with tests/fixtures/qq-guide-install.txt. MAC_PYTHON is that page's "On a Mac, set up Python first" command.

/** Each runs inside `( … )`, so it leaves the shell as it was, and each is safe to run again. */
export const INSTALL = [
  {
    what: "Install qq",
    cmd: "( set -e; mkdir -p ~/qq-tools; rm -rf ~/qq-tools/depot; git clone -q https://github.com/quirq-ai/qq ~/qq-tools/depot; ~/qq-tools/depot/bin/qq --version )",
  },
  {
    what: "Install qqsync (pinned to the sync commit qq itself pins)",
    cmd: "( set -e; mkdir -p ~/qq-tools; rm -rf ~/qq-tools/qqsync; \"${QQ_PYTHON:-python3}\" -m venv ~/qq-tools/qqsync; ~/qq-tools/qqsync/bin/pip install -q --disable-pip-version-check \"qqsync @ git+https://github.com/quirq-ai/sync@9821f745690d5150cac70cd2eee54c97d431e6c3\"; ~/qq-tools/qqsync/bin/qqsync --version )",
  },
  {
    what: "Put both on your PATH (adds one line to ~/.bashrc for bash, to ~/.zshrc otherwise, and on a Mac to the first of ~/.bash_profile, ~/.bash_login or ~/.profile that bash already reads; open a new terminal afterwards)",
    cmd: "( case \"$SHELL:$(uname)\" in */bash:Darwin) for rc in ~/.bash_profile ~/.bash_login ~/.profile ~/.bash_profile; do [ -f \"$rc\" ] && break; done ;; */bash:*) rc=~/.bashrc ;; *) rc=~/.zshrc ;; esac; mkdir -p ~/qq-tools/bin && ln -sf ~/qq-tools/depot/bin/qq ~/qq-tools/qqsync/bin/qqsync ~/qq-tools/bin/ && { grep -qs 'qq-tools/bin:' \"$rc\" || printf '\\nexport PATH=\"$HOME/qq-tools/bin:$PATH\"\\n' >> \"$rc\"; } && echo \"qq-tools/bin is on PATH in $rc; open a new terminal\" )",
  },
];

/** On a Mac, before INSTALL: macOS's python3 is 3.9, and brew's python@3.13 adds only python3.13, so
 * qq is told to use it (qq bin/qq:20). The qq guide's command, copied unchanged. */
export const MAC_PYTHON = {
  what: "On a Mac, first give qq a new enough Python (macOS's python3 is 3.9), then open a new terminal. If your shell is bash, put the export line in the first of ~/.bash_profile, ~/.bash_login or ~/.profile that you have instead",
  cmd: "brew install python@3.13 && { grep -qs 'QQ_PYTHON=' ~/.zshrc || echo 'export QQ_PYTHON=python3.13' >> ~/.zshrc; }",
};

/** The install steps for this platform: on a Mac, Python first. @param {string} platform */
export function installFor(platform) {
  return platform === "darwin" ? [MAC_PYTHON, ...INSTALL] : INSTALL;
}

/** The Python qq's launcher runs (qq bin/qq:20): QQ_PYTHON when set and not empty, else python3. */
export function qqPython(/** @type {Record<string, string | undefined>} */ env) {
  return env.QQ_PYTHON || "python3";
}

/** One statement about macOS, shared with preflight and the README (a test keeps them equal). */
export const MAC =
  "qq fetches toolchains for Linux x86_64 only, so on a Mac qq fetch clones the repo and then stops with " +
  "\"no pin for platform\", and qq sync stops the same way: clone with git and install the repo's pinned tools " +
  "yourself (qqsync show infra/repo.toml lists them). qq build and qq test then use them, from " +
  "--toolchain NAME=ROOT or your PATH, and still check the pinned versions (exact Python, Node major); " +
  "qq run uses your PATH.";
