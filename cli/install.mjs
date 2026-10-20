// @ts-check
// qq-setup install: install, update or remove qq (with qqsync) and xo on this machine. It looks at what
// is already here, asks what to do with each, shows the exact commands, and runs them only after a yes.
// It changes files only in your home directory (~/qq-tools, ~/.xo, ~/.cache/qq, xo's saved key and
// your shell's startup file), except that on a Mac with no new enough Python its first step is
// `brew install python@3.13`, which writes to Homebrew's prefix. It never writes to GitHub; `xo logout`
// asks GitHub, through gh, who you are. The commands are the qq guide's and the xo quickstart's, copied
// unchanged where they exist (tests/fixtures/qq-guide-*.txt and xo-quickstart.txt; scripts/check-guide.mjs
// checks them), with each difference named where it is made.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { INSTALL, MAC_PYTHON } from "./tools.mjs";
import { windowsNote } from "./windows.mjs";

/** The qq guide's "Remove everything" commands (quirq-ai/docs content/docs/install.mdx, at 3f8df0d). */
export const QQ_REMOVE = [
  "( chmod -R u+w ~/.cache/qq 2>/dev/null; rm -rf ~/qq-tools ~/qq-try ~/qq-ci-venv ~/.cache/qq )",
  "( for f in ~/.bashrc ~/.bash_profile ~/.bash_login ~/.profile ~/.zshrc; do grep -qsxF 'export PATH=\"$HOME/qq-tools/bin:$PATH\"' \"$f\" || continue; awk '$0 == \"export PATH=\\\"$HOME/qq-tools/bin:$PATH\\\"\" { if (b > 0) b--; next } /^$/ { b++; next } { while (b > 0) { print \"\"; b-- } print } END { while (b > 0) { print \"\"; b-- } }' \"$f\" >| \"$f.qq-tmp\" || exit 1; if [ -L \"$f\" ] || grep -q '[^[:space:]]' \"$f.qq-tmp\"; then cat \"$f.qq-tmp\" >| \"$f\" || exit 1; rm -f \"$f.qq-tmp\"; echo \"removed the qq-tools/bin line from $f\"; else rm -f \"$f\" \"$f.qq-tmp\"; echo \"deleted $f, which held only that line\"; fi; done )",
];
/** The guide's demo folders: qq never put them there, so each is deleted only when you say so. */
export const DEMO = ["qq-try", "qq-ci-venv"];
/** The guide's first remove command without the demo folders. */
export const QQ_REMOVE_TOOLS = QQ_REMOVE[0].replace(" ~/qq-try ~/qq-ci-venv", "");

/**
 * The guide's PATH-line command leaves `$f.qq-tmp` behind when it cannot write; this one deletes it.
 * @param {string} cmd  QQ_REMOVE[1] or removeLineCmd(...)
 */
export function cleanTmp(cmd) {
  return cmd
    .replace('>| "$f.qq-tmp" || exit 1;', '>| "$f.qq-tmp" || { rm -f "$f.qq-tmp"; exit 1; };')
    .replace('cat "$f.qq-tmp" >| "$f" || exit 1;', 'cat "$f.qq-tmp" >| "$f" || { rm -f "$f.qq-tmp"; exit 1; };');
}

/** The commit of xo the xo quickstart installs (quirq-ai/xo docs/quickstart.md:18, at b61bc4c). */
export const XO_PIN = "ab7d88637ecfbd8a69e2e458938ded0518bca41c";
export const XO_SPEC = `quirq-xo @ git+https://github.com/quirq-ai/xo@${XO_PIN}`;
export const XO_PATH_LINE = 'export PATH="$HOME/.xo/bin:$PATH"';
/** The startup files the qq guide's PATH step can write, and its remove step reads. */
const RC_FILES = [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc"];
// The qq guide's PATH step's choice of startup file, so xo's line lands in the same one.
const PICK_RC =
  "case \"$SHELL:$(uname)\" in */bash:Darwin) for rc in ~/.bash_profile ~/.bash_login ~/.profile ~/.bash_profile; do [ -f \"$rc\" ] && break; done ;; */bash:*) rc=~/.bashrc ;; *) rc=~/.zshrc ;; esac";

/**
 * The qq guide's remove-the-PATH-line command for any one exact line: it deletes that line and the
 * blank line before it, and the file if nothing else is left. For qq's line it is QQ_REMOVE[1].
 * @param {string} line  a line with no single quote or backslash
 * @param {string} label  what to call it in the message
 */
export function removeLineCmd(line, label) {
  const awkLine = line.replaceAll('"', '\\"');
  return `( for f in ~/.bashrc ~/.bash_profile ~/.bash_login ~/.profile ~/.zshrc; do grep -qsxF '${line}' "$f" || continue; awk '$0 == "${awkLine}" { if (b > 0) b--; next } /^$/ { b++; next } { while (b > 0) { print ""; b-- } print } END { while (b > 0) { print ""; b-- } }' "$f" >| "$f.qq-tmp" || exit 1; if [ -L "$f" ] || grep -q '[^[:space:]]' "$f.qq-tmp"; then cat "$f.qq-tmp" >| "$f" || exit 1; rm -f "$f.qq-tmp"; echo "removed the ${label} line from $f"; else rm -f "$f" "$f.qq-tmp"; echo "deleted $f, which held only that line"; fi; done )`;
}

/** @typedef {{ what: string, cmd: string }} Step */
const NOT_ON_PATH = "not on PATH";

export const XO = {
  /** The quickstart's install, as the qq guide's steps are written: in ( … ), with the Python picked.
   * --clear, so a venv a stopped run left half made is made again. */
  install: { what: "Install xo (pinned to the commit the xo quickstart installs)",
    cmd: `( set -e; "\${QQ_PYTHON:-python3}" -m venv --clear ~/.xo; ~/.xo/bin/pip install -q --disable-pip-version-check "${XO_SPEC}"; ~/.xo/bin/xo --version )` },
  path: { what: "Put xo on your PATH (the same startup file as qq's PATH line; open a new terminal afterwards)",
    cmd: `( ${PICK_RC}; { grep -qsxF '${XO_PATH_LINE}' "$rc" || printf '\\n${XO_PATH_LINE}\\n' >> "$rc"; } && echo "~/.xo/bin is on PATH in $rc; open a new terminal" )` },
  /** The quickstart's update, at the pinned commit. */
  update: { what: "Update xo to the pinned commit",
    cmd: `~/.xo/bin/pip install --force-reinstall --no-deps "${XO_SPEC}"` },
  remove: [
    // When xo cannot run (a broken ~/.xo), delete the two files xo logout deletes (xo client.py
    // credentials_path, services.py addresses_path) so the key never outlives the tool.
    { what: "Log xo out: deletes the saved XO key (xo asks before logging gh out too)",
      cmd: "( ~/.xo/bin/xo logout || { case \"$XDG_CONFIG_HOME\" in /*) c=\"$XDG_CONFIG_HOME\" ;; *) c=\"$HOME/.config\" ;; esac; rm -f \"$c/xo/credentials\" \"$c/xo/services\" && echo \"xo logout did not run; deleted $c/xo/credentials and $c/xo/services instead\"; } )" },
    { what: "Delete xo's folder", cmd: "rm -rf ~/.xo" },
    { what: "Remove xo's PATH line", cmd: cleanTmp(removeLineCmd(XO_PATH_LINE, ".xo/bin")) },
  ],
};

/** xo's programs on Windows: the quickstart's venv at %USERPROFILE%\.xo keeps them in Scripts\. */
const XO_WIN_BIN = "%USERPROFILE%\\.xo\\Scripts";
/**
 * A PowerShell command on the user's own PATH (HKCU\Environment), for cmd.exe: setx would cut a PATH at
 * 1024 characters, and [Environment]::SetEnvironmentVariable would rewrite %VAR% entries expanded. The
 * value is read and written as is (an ExpandString), then setting an unused variable to nothing makes
 * Windows tell new terminals that the environment changed. No double quotes inside: cmd.exe would end the
 * quoted -Command there.
 * @param {string} body  PowerShell with $d (xo's Scripts folder), $k (the key) and $parts (PATH's entries)
 */
const userPath = (body) => "powershell -NoProfile -Command \"$d = Join-Path $env:USERPROFILE '.xo\\Scripts'; " +
  "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); " +
  "$parts = @([string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $_ }); " +
  body + "\"";
const TELL = "[Environment]::SetEnvironmentVariable('QQ_SETUP_UNUSED', $null, 'User')";

/** xo on Windows, as cmd.exe commands: the same venv, pin and logout as XO, in Windows' folders. */
export const XO_WIN = {
  install: { what: XO.install.what,
    cmd: `"%QQ_PYTHON%" -m venv --clear "%USERPROFILE%\\.xo" && "${XO_WIN_BIN}\\python.exe" -m pip install -q --disable-pip-version-check "${XO_SPEC}" && "${XO_WIN_BIN}\\xo.exe" --version` },
  path: { what: "Put xo on your PATH (your Windows user PATH; open a new terminal afterwards)",
    cmd: userPath(`if ($parts -notcontains $d) { $k.SetValue('Path', (@($parts) + $d) -join ';', 'ExpandString'); ${TELL} }; ` +
      "Write-Output ($d + ' is on your user PATH; open a new terminal')") },
  update: { what: XO.update.what,
    cmd: `"${XO_WIN_BIN}\\python.exe" -m pip install --force-reinstall --no-deps "${XO_SPEC}"` },
  remove: [
    // As XO.remove: when xo cannot run, delete the files xo logout deletes (with XDG_CONFIG_HOME unset).
    { what: XO.remove[0].what,
      cmd: `"${XO_WIN_BIN}\\xo.exe" logout || (del /f /q "%USERPROFILE%\\.config\\xo\\credentials" "%USERPROFILE%\\.config\\xo\\services" 2>nul & echo xo logout did not run; deleted the key files in %USERPROFILE%\\.config\\xo instead)` },
    { what: XO.remove[1].what, cmd: `rmdir /s /q "%USERPROFILE%\\.xo"` },
    { what: "Take xo off your PATH (your Windows user PATH)",
      cmd: userPath(`if ($parts -contains $d) { $k.SetValue('Path', (@($parts | Where-Object { $_ -ne $d })) -join ';', 'ExpandString'); ${TELL} }; ` +
        "Write-Output ($d + ' is not on your user PATH')") },
  ],
};

/** On a Mac with no new enough Python and only xo wanted: brew's Python without the QQ_PYTHON line. */
export const BREW_PYTHON = { what: "On a Mac, first install a new enough Python (macOS's python3 is 3.9)",
  cmd: /** @type {string} */ (MAC_PYTHON.cmd.split(" && ")[0]) };

/** The sync commit qq's guide installs qqsync at (INSTALL[1]). */
export const SYNC_PIN = /** @type {string} */ (/sync@([0-9a-f]{40})/.exec(INSTALL[1].cmd)?.[1]);

/**
 * @typedef {{ installed: boolean, broken: boolean, commit: string | null, latest: string | null,
 *   syncPin: string | null, onPath: boolean, behind: string[], localWork: string | null,
 *   pythonLine: { line: string, files: string[] } | null, unsupported?: boolean }} QqState
 *   pythonLine: an exact `export QQ_PYTHON=python3.N` line, the form qq-setup and the qq guide write;
 *   unsupported: on Windows, where qq does not run
 * @typedef {{ installed: boolean, broken: boolean, pin: string | null, onPath: boolean, behind: string[],
 *   note: string | null, foreign: boolean }} XoState
 * @typedef {{ qq: QqState, xo: XoState }} State
 * @typedef {{ cmd: string | null, version: string | null, ok: boolean, persist: boolean }} PythonPick
 * @typedef {(file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string | null>} Read
 */

/** Run a program and return its stdout, or null when it is missing, fails or takes too long. @type {Read} */
export function read(file, args, env = process.env) {
  return new Promise((ok) => {
    execFile(file, args, { timeout: 30_000, env }, (err, stdout) => ok(err ? null : String(stdout)));
  });
}

/** The startup files in home with a line that passes the test. @param {string} home @param {(l: string) => boolean} test */
function rcWith(home, test) {
  return RC_FILES.filter((f) => {
    try {
      return readFileSync(join(home, f), "utf8").split("\n").some(test);
    } catch {
      return false;
    }
  });
}

/** The first exact QQ_PYTHON line in the startup files, and every file that has it. @param {string} home */
function pythonLineIn(home) {
  for (const f of RC_FILES) {
    let text = "";
    try {
      text = readFileSync(join(home, f), "utf8");
    } catch {
      continue;
    }
    const line = text.split("\n").find((l) => PYTHON_LINE.test(l));
    if (line) return { line, files: rcWith(home, (l) => l === line) };
  }
  return null;
}
const PYTHON_LINE = /^export QQ_PYTHON=python3\.\d+$/;

/** The commit a pip venv installed a git package at. @param {string | null} freeze @param {string} pkg */
export function pinIn(freeze, pkg) {
  const m = new RegExp(`^${pkg} @ git\\+https://github\\.com/quirq-ai/[\\w.-]+@([0-9a-f]{40})$`, "m").exec(freeze ?? "");
  return m ? m[1] : null;
}

/**
 * What reinstalling or removing qq's checkout would lose, as phrases; empty when there is nothing.
 * It counts files git status shows (changed, staged or untracked; not ones git is told to ignore), commits
 * no remote branch has (on any branch or tag, a detached HEAD, or only in a reflog, as after a reset),
 * stashes and other worktrees. When git cannot tell, that is work too, so qq is kept.
 * @param {string} depot @param {Read} run @returns {Promise<string[]>}
 */
export async function localWork(depot, run) {
  const git = (/** @type {string[]} */ ...args) => run("git", ["-C", depot, ...args]);
  // --untracked-files=normal: a user's status.showUntrackedFiles=no must not hide untracked files.
  const status = await git("status", "--porcelain", "--untracked-files=normal");
  const commits = await git("rev-list", "--count", "HEAD", "--branches", "--tags", "--reflog", "--not", "--remotes");
  const stashes = await git("stash", "list");
  const trees = await git("worktree", "list", "--porcelain");
  if (status === null || commits === null || stashes === null || trees === null || !/^\d+$/.test(commits.trim())) {
    return ["files git could not check"];
  }
  /** @param {number} n @param {string} one */
  const count = (n, one) => `${n} ${one}${n === 1 ? "" : one.endsWith("h") ? "es" : "s"}`;
  /** @type {string[]} */
  const work = [];
  if (status.trim()) work.push("uncommitted or untracked files");
  const ahead = Number(commits.trim());
  if (ahead) work.push(`${count(ahead, "commit")} on no remote branch`);
  const stash = stashes.split("\n").filter(Boolean).length;
  if (stash) work.push(count(stash, "stash"));
  const others = trees.split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
  if (others > 0) work.push(count(others, "other worktree"));
  return work;
}

/**
 * Look at what is installed. Reads only: files under home, `git status`, `rev-parse`, `rev-list`,
 * `stash list` and `worktree list` in qq's checkout, `pip freeze` in the two venvs, `xo --version`
 * and, unless `latest` is given, `git ls-remote` for qq's newest commit. On Windows only xo is looked
 * at, and the user PATH (`reg query`).
 * @param {{ home: string, latest?: string | null, run?: Read, platform?: string }} o
 * @returns {Promise<State>}
 */
export async function detect({ home, latest, run = read, platform = process.platform }) {
  if (platform === "win32") return detectWindows(home, run);
  const depot = join(home, "qq-tools", "depot");
  const qqHere = existsSync(join(depot, "bin", "qq"));
  const commit = qqHere ? (await run("git", ["-C", depot, "rev-parse", "HEAD"]))?.trim() || null : null;
  const work = existsSync(depot) ? await localWork(depot, run) : [];
  if (qqHere && latest === undefined) latest = (await run("git", ["ls-remote", "https://github.com/quirq-ai/qq", "HEAD"]))?.split(/\s/)[0] || null;
  const syncPip = join(home, "qq-tools", "qqsync", "bin", "pip");
  const syncPin = existsSync(syncPip) ? pinIn(await run(syncPip, ["freeze", "--disable-pip-version-check"]), "qqsync") : null;
  // The same test as the guide's PATH step's guard (grep 'qq-tools/bin:'), so a line it accepts counts.
  const qqOnPath = existsSync(join(home, "qq-tools", "bin", "qq")) && rcWith(home, (l) => l.includes("qq-tools/bin:")).length > 0;
  /** @type {string[]} */
  const qqBehind = [];
  if (qqHere) {
    if (!work.length && latest && commit && latest !== commit) qqBehind.push(`qq ${commit.slice(0, 7)} is behind ${latest.slice(0, 7)}`);
    if (syncPin !== SYNC_PIN) qqBehind.push(syncPin ? `qqsync is at ${syncPin.slice(0, 7)}, not ${SYNC_PIN.slice(0, 7)}` : "qqsync is not installed");
    if (!qqOnPath) qqBehind.push(NOT_ON_PATH);
  }

  const xoDir = existsSync(join(home, ".xo"));
  // Only a venv (pyvenv.cfg) is xo's: any other ~/.xo is someone else's folder and is never touched.
  const xoVenv = existsSync(join(home, ".xo", "pyvenv.cfg"));
  const xoBin = join(home, ".xo", "bin", "xo");
  // Asked twice before calling it broken, so one slow start never turns into a reinstall.
  const xoRuns = async () => (await run(xoBin, ["--version"])) !== null || (await run(xoBin, ["--version"])) !== null;
  const xoHere = xoVenv && existsSync(xoBin) && (await xoRuns());
  const pin = xoHere ? pinIn(await run(join(home, ".xo", "bin", "pip"), ["freeze", "--disable-pip-version-check"]), "quirq-xo") : null;
  // Any line naming .xo/bin:, as qq's check takes any line naming qq-tools/bin:.
  const xoOnPath = rcWith(home, (l) => l.includes(".xo/bin:")).length > 0;
  // A commit other than the pin may be newer (the XO team hands out commits): say so, never call it behind.
  const note = xoHere && pin !== XO_PIN
    ? `xo is ${pin ? `at ${pin.slice(0, 7)}` : "at a commit pip does not name"}, not setup's pin ${XO_PIN.slice(0, 7)}; updating would put it at ${XO_PIN.slice(0, 7)}`
    : null;
  return {
    qq: { installed: qqHere, broken: !qqHere && existsSync(depot), commit, latest: latest ?? null, syncPin, onPath: qqOnPath,
      behind: qqBehind, localWork: work.length ? work.join(" and ") : null, pythonLine: pythonLineIn(home) },
    xo: { installed: xoHere, broken: xoVenv && !xoHere, foreign: xoDir && !xoVenv, pin, onPath: xoOnPath, behind: xoHere && !xoOnPath ? [NOT_ON_PATH] : [], note },
  };
}

/** On Windows: qq is never offered, and xo is the venv at home\.xo with its programs in Scripts\. @param {string} home @param {Read} run */
async function detectWindows(home, run) {
  const venv = join(home, ".xo");
  const xoBin = join(venv, "Scripts", "xo.exe");
  const xoVenv = existsSync(join(venv, "pyvenv.cfg"));
  const xoRuns = async () => (await run(xoBin, ["--version"])) !== null || (await run(xoBin, ["--version"])) !== null;
  const xoHere = xoVenv && existsSync(xoBin) && (await xoRuns());
  const pin = xoHere ? pinIn(await run(join(venv, "Scripts", "pip.exe"), ["freeze", "--disable-pip-version-check"]), "quirq-xo") : null;
  // The user PATH as stored: an entry naming .xo\Scripts, expanded or written with %USERPROFILE%.
  const userPath = (await run("reg", ["query", "HKCU\\Environment", "/v", "Path"])) ?? "";
  const onPath = /\\\.xo\\Scripts\\?(;|\s|$)/i.test(userPath);
  const note = xoHere && pin !== XO_PIN
    ? `xo is ${pin ? `at ${pin.slice(0, 7)}` : "at a commit pip does not name"}, not setup's pin ${XO_PIN.slice(0, 7)}; updating would put it at ${XO_PIN.slice(0, 7)}`
    : null;
  return {
    qq: { installed: false, broken: false, commit: null, latest: null, syncPin: null, onPath: false, behind: [], localWork: null,
      pythonLine: null, unsupported: true },
    xo: { installed: xoHere, broken: xoVenv && !xoHere, foreign: existsSync(venv) && !xoVenv, pin, onPath,
      behind: xoHere && !onPath ? [NOT_ON_PATH] : [], note },
  };
}

/** @param {string | null} out  `python --version` output @param {number[]} [min] */
export function pythonOk(out, min = [3, 11, 4]) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out ?? "");
  if (!m) return false;
  const v = m.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/**
 * The Python to make qq's and xo's venvs with: QQ_PYTHON when set, else python3, else the newest
 * python3.N on PATH (on Windows: python, else the py launcher). `persist` says qq needs QQ_PYTHON in the
 * startup file to find it later.
 * @param {NodeJS.ProcessEnv} env @param {number[]} min @param {Read} [run] @param {string} [platform]
 * @returns {Promise<PythonPick>}
 */
export async function pickPython(env, min, run = read, platform = process.platform) {
  if (env.QQ_PYTHON) {
    const version = (await run(env.QQ_PYTHON, ["--version"], env))?.trim() || null;
    return { cmd: env.QQ_PYTHON, version, ok: pythonOk(version, min), persist: false };
  }
  /** @type {string | null} */
  let first = null;
  const names = platform === "win32" ? ["python", "py"] : ["python3", "python3.14", "python3.13", "python3.12", "python3.11"];
  for (const cmd of names) {
    const version = (await run(cmd, ["--version"], env))?.trim() || null;
    if (cmd === names[0]) first = version;
    if (pythonOk(version, min)) return { cmd, version, ok: true, persist: platform !== "win32" && cmd !== "python3" };
  }
  return { cmd: null, version: first, ok: false, persist: false };
}

/** How to get a Python on Linux, where qq-setup does not install one: uv needs no sudo and works on any
 * distribution (Ubuntu 22.04's own python3.11 is 3.11.0, below qq's 3.11.4). The link is uv's install
 * page; the version is named, because uv's own Python guide starts with `uv python install`, the newest
 * Python (3.15 now), and qq-setup looks for python3.11 to python3.14 only. uv puts python3.13 in
 * ~/.local/bin, which its installer puts on PATH for new terminals. */
export const PYTHON_HELP = "https://docs.astral.sh/uv/getting-started/installation/";
export const PYTHON_CMD = "uv python install 3.13";

/** Windows' Python: python.org's installer, which can put python.exe on PATH. */
export const PYTHON_WIN = "https://www.python.org/downloads/windows/";

/**
 * What to do about a Python that is too old, after the version found.
 * @param {PythonPick} python  cmd is set only when QQ_PYTHON named it
 * @param {string} [platform]
 */
export function pythonHelp(python, platform = "linux") {
  if (platform === "win32") {
    return `Install Python 3.13 from python.org ( ${PYTHON_WIN} ), ticking "Add python.exe to PATH" in its installer, ` +
      "open a new terminal, then run qq-setup's command again. " +
      (python.cmd ? `QQ_PYTHON is set to ${python.cmd}: point it at the new python.exe.` : "qq-setup then finds python by itself.");
  }
  return `Install Python 3.13 with uv, which needs no sudo: install uv ( ${PYTHON_HELP} ), open a new terminal, run  ${PYTHON_CMD}  then run qq-setup's command again. ` +
    (python.cmd ? `QQ_PYTHON is set to ${python.cmd}: point it at python3.13.` : "qq-setup then finds python3.13 by itself.");
}

/** Write QQ_PYTHON to the startup file the PATH step uses, unless one is there. @param {string} py */
export function persistPython(py) {
  if (!/^python3\.\d+$/.test(py)) throw new Error(`not a python3.N name: ${py}`);
  return { what: `Tell qq to use ${py} (adds export QQ_PYTHON=${py} to your shell's startup file)`,
    cmd: `( ${PICK_RC}; { grep -qs 'QQ_PYTHON=' "$rc" || printf '\\nexport QQ_PYTHON=${py}\\n' >> "$rc"; } && echo "QQ_PYTHON is set in $rc" )` };
}

/** @typedef {"install" | "update" | "remove" | "keep" | "path"} Action  path: only add the PATH line */

/** @param {{ qq: Action, xo: Action }} a */
const usesQq = (a) => a.qq === "install" || a.qq === "update";
/** @param {{ qq: Action, xo: Action }} a @param {State} s */
const freshXo = (a, s) => a.xo === "install" || (a.xo === "update" && !s.xo.installed);

/** The Python floor for these actions: qq's launcher wants 3.11.4, xo 3.11. @param {{ qq: Action, xo: Action }} a */
export function pythonFloor(a) {
  return usesQq(a) ? [3, 11, 4] : [3, 11, 0];
}

/**
 * The steps for the chosen actions, in order: Python first when an install needs it, then qq, then xo.
 * @param {{ qq: Action, xo: Action }} actions
 * @param {State} state
 * @param {{ python: PythonPick, platform: string, git: boolean, demo?: string[], pythonLine?: boolean }} ctx
 *   git: git is installed; demo: the guide's demo folders to delete with qq; pythonLine: also delete
 *   qq's exact QQ_PYTHON line with qq
 * @returns {{ steps: Step[], stop: string | null }}  stop: why nothing can run
 */
export function planSteps(actions, state, { python, platform, git, demo = [], pythonLine = false }) {
  if (platform === "win32") return planWindows(actions, state, { python, git });
  /** @type {Step[]} */
  const steps = [];
  const qq = usesQq(actions);
  const xo = freshXo(actions, state);
  if ((qq || xo) && !git) {
    return { steps, stop: `git is needed to install ${qq ? "qq" : "xo"} and is not installed${platform === "darwin" ? " (on a Mac: xcode-select --install)" : ""}` };
  }
  if ((qq || xo) && !python.ok) {
    const floor = pythonFloor(actions).join(".").replace(/\.0$/, "");
    if (platform !== "darwin") {
      return { steps, stop: `${qq ? "qq" : "xo"} needs Python ${floor} or newer (found ${python.version ?? "none"}). ${pythonHelp(python)}` };
    }
    // Not the guide's MAC_PYTHON, which always writes ~/.zshrc: a bash user's next terminal would
    // have qq on PATH but no QQ_PYTHON. The line goes where the PATH step puts qq's.
    steps.push(BREW_PYTHON);
    if (qq) steps.push(persistPython("python3.13"));
  } else if (qq && python.persist && python.cmd) {
    steps.push(persistPython(python.cmd));
  }
  if (qq) steps.push(...INSTALL);
  if (actions.qq === "path") steps.push(/** @type {Step} */ (INSTALL[2]));
  if (actions.qq === "remove") {
    steps.push({ what: "Remove qq, qqsync and qq's cache (~/qq-tools, ~/.cache/qq)", cmd: QQ_REMOVE_TOOLS });
    for (const d of demo) steps.push({ what: `Delete ~/${d}, the qq guide's demo folder`, cmd: `rm -rf ~/${d}` });
    steps.push({ what: "Remove qq's PATH line", cmd: cleanTmp(QQ_REMOVE[1]) });
    const py = state.qq.pythonLine;
    if (pythonLine && py) {
      steps.push({ what: `Remove the ${py.line} line (${py.files.map((f) => `~/${f}`).join(", ")})`, cmd: cleanTmp(removeLineCmd(py.line, "QQ_PYTHON")) });
    }
  }
  if (xo) steps.push(XO.install);
  else if (actions.xo === "update") steps.push(XO.update);
  if ((xo || actions.xo === "update") && !state.xo.onPath) steps.push(XO.path);
  if (actions.xo === "path") steps.push(XO.path);
  if (actions.xo === "remove") steps.push(...XO.remove);
  return { steps, stop: null };
}

/**
 * The steps on Windows, in cmd.exe: xo only, since qq does not run there.
 * @param {{ qq: Action, xo: Action }} actions @param {State} state
 * @param {{ python: PythonPick, git: boolean }} ctx @returns {{ steps: Step[], stop: string | null }}
 */
function planWindows(actions, state, { python, git }) {
  /** @type {Step[]} */
  const steps = [];
  if (actions.qq !== "keep") return { steps, stop: "qq runs on Linux and macOS, so qq-setup cannot install, update or remove it on Windows" };
  const xo = freshXo(actions, state);
  if (xo && !git) return { steps, stop: "git is needed to install xo and is not installed (on Windows: https://git-scm.com/downloads/win )" };
  if (xo && !python.ok) {
    return { steps, stop: `xo needs Python 3.11 or newer (found ${python.version ?? "none"}). ${pythonHelp(python, "win32")}` };
  }
  if (xo) steps.push(XO_WIN.install);
  else if (actions.xo === "update") steps.push(XO_WIN.update);
  if (((xo || actions.xo === "update") && !state.xo.onPath) || actions.xo === "path") steps.push(XO_WIN.path);
  if (actions.xo === "remove") steps.push(...XO_WIN.remove);
  return { steps, stop: null };
}

/** The tool's only problem is its missing PATH line. @param {{ behind: string[] }} t */
export const pathOnly = (t) => t.behind.length === 1 && t.behind[0] === NOT_ON_PATH;

/**
 * What a person may choose for one tool in its state, first the default (defaultAction with no flags):
 * the same choices the terminal asks about. Remove is never first, and a ~/.xo that is not xo's offers
 * nothing.
 * @param {QqState | XoState} t @returns {Action[]}
 */
export function choices(t) {
  /** @type {Action[]} */
  const all = ("foreign" in t && t.foreign) || ("unsupported" in t && t.unsupported) ? []
    : t.broken ? ["install", "remove", "keep"]
      : !t.installed ? ["install", "keep"]
        : pathOnly(t) ? ["path", "update", "remove", "keep"]
          : ["keep", "update", "remove"];
  const first = defaultAction(t, {});
  return all.includes(first) ? [first, ...all.filter((a) => a !== first)] : all;
}

/**
 * Everything the steps need: the Python and git checks, the steps in order, and the environment they
 * run with (QQ_PYTHON set to the Python picked, or brew's python3.13 once the Mac step has run).
 * @param {{ qq: Action, xo: Action }} actions @param {State} state
 * @param {{ demo: string[], pythonLine?: boolean, env: NodeJS.ProcessEnv, platform: string, run: Read }} o
 * @returns {Promise<{ steps: Step[], stop: string | null, python: PythonPick, env: NodeJS.ProcessEnv }>}
 */
export async function prepare(actions, state, { demo, pythonLine = false, env, platform, run }) {
  const needs = usesQq(actions) || freshXo(actions, state);
  const python = needs ? await pickPython(env, pythonFloor(actions), run, platform) : { cmd: null, version: null, ok: true, persist: false };
  const git = !needs || (await run("git", ["--version"], env)) !== null;
  const { steps, stop } = planSteps(actions, state, { python, platform, git, demo, pythonLine });
  const py = python.ok ? python.cmd : platform === "darwin" ? "python3.13" : null;
  return { steps, stop, python, env: py ? { ...env, QQ_PYTHON: py } : env };
}

/** What to tell the person after the steps ran. @param {{ qq: Action, xo: Action }} actions @param {string} home */
export function afterNotes(actions, home) {
  /** @type {string[]} */
  const lines = [];
  if (actions.qq === "remove") {
    for (const rc of rcWith(home, (l) => /^\s*export QQ_PYTHON=/.test(l))) {
      lines.push(`~/${rc} still sets QQ_PYTHON; delete that line unless something else uses that Python.`);
    }
  }
  // The remove steps delete only the exact lines the install writes; say where another form is left.
  for (const [tool, dir] of /** @type {const} */ ([["qq", "qq-tools/bin:"], ["xo", ".xo/bin:"]])) {
    if (actions[tool] !== "remove") continue;
    for (const rc of rcWith(home, (l) => l.includes(dir))) lines.push(`~/${rc} still has a line naming ${dir.slice(0, -1)}; delete it yourself.`);
  }
  return lines;
}

/** One line per tool for the terminal. @param {State} s @returns {string[]} */
export function describe(s) {
  const qq = s.qq.unsupported ? "not on Windows: qq runs on Linux and macOS"
    : s.qq.broken ? "not working: ~/qq-tools/depot is there without bin/qq"
    : !s.qq.installed ? "not installed"
      : `installed at ${s.qq.commit?.slice(0, 7) ?? "an unknown commit"}` +
        (s.qq.localWork ? `, with local work (${s.qq.localWork})`
          : s.qq.latest ? (s.qq.latest === s.qq.commit ? " (the newest)" : `, newest is ${s.qq.latest.slice(0, 7)}`) : " (could not check the newest)") +
        `; qqsync ${s.qq.syncPin ? `at ${s.qq.syncPin.slice(0, 7)}` : "missing"}` +
        `; ${s.qq.onPath ? "on PATH" : "not on PATH"}` + (pathOnly(s.qq) ? ": needs its PATH step" : s.qq.behind.length ? ": update available" : s.qq.localWork ? "" : ": up to date");
  const xo = s.xo.foreign ? "~/.xo is there but is not an xo install (no pyvenv.cfg); it is left alone"
    : s.xo.broken ? "not working: ~/.xo is xo's venv but its xo does not run"
    : !s.xo.installed ? "not installed"
      : `installed at ${s.xo.pin?.slice(0, 7) ?? "an unknown commit"}; ${s.xo.onPath ? "on PATH" : "not on PATH"}` +
        (s.xo.pin !== XO_PIN ? `: not at setup's pin (${XO_PIN.slice(0, 7)})` : pathOnly(s.xo) ? ": needs its PATH step" : s.xo.behind.length ? ": update available" : ": up to date");
  return [`  qq  ${qq}`, `  xo  ${xo}`];
}

/**
 * The action for one tool with no question asked: --remove removes, otherwise an absent or broken tool
 * is installed, one that is only missing its PATH line gets just that line, and one that is behind is
 * updated (also with --update, which reruns an up-to-date one). A qq checkout with local work is kept:
 * updating or removing it would delete that work. A ~/.xo that is not xo's is never touched.
 * @param {{ installed: boolean, broken: boolean, behind: string[], localWork?: string | null, foreign?: boolean, unsupported?: boolean }} t
 * @param {{ remove?: boolean, update?: boolean }} flags
 * @returns {Action}
 */
export function defaultAction(t, flags) {
  if (t.foreign || t.unsupported) return "keep";
  // Adding the PATH line touches no checkout, so it is the default even with local work.
  if (!flags.remove && !flags.update && t.installed && pathOnly(t)) return "path";
  if (t.localWork) return "keep";
  if (flags.remove) return t.installed || t.broken ? "remove" : "keep";
  if (!t.installed) return "install";
  return t.behind.length || flags.update ? "update" : "keep";
}

/**
 * How one step runs: in sh, or in cmd.exe on Windows (Node's shell there: %ComSpec% /d /s /c).
 * @param {string} cmd @param {string} [platform] @returns {[string, string[], { shell?: boolean }]}
 */
export function stepCommand(cmd, platform = process.platform) {
  return platform === "win32" ? [cmd, [], { shell: true }] : ["/bin/sh", ["-c", cmd], {}];
}

/** Run one step in sh (cmd.exe on Windows), showing its output; resolves to its exit code. @param {string} cmd @param {NodeJS.ProcessEnv} env */
export function runStep(cmd, env) {
  return new Promise((ok) => {
    const [file, args, opts] = stepCommand(cmd);
    const child = spawn(file, args, { ...opts, stdio: "inherit", env });
    child.on("error", () => ok(127));
    child.on("exit", (code, signal) => ok(code ?? (signal ? 128 : 1)));
  });
}

const USAGE = `qq-setup install: install, update or remove qq (with qqsync) and xo on this machine.

  npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/<commit> install [--only qq|xo] [--update | --remove] [--yes] [--dry-run]

It shows what is installed, asks what to do with each tool (install what is missing; update, remove or
keep what is there), prints the exact commands, and runs them after you say yes. On Windows it handles
xo only, in %USERPROFILE%\\.xo with cmd.exe commands; qq runs on Linux and macOS.

  --only qq|xo   only this tool (qq includes qqsync); default both
  --update       update what is installed (rerun its install), install what is missing
  --remove       remove the tools instead
  --yes          no questions: do the default (or --update / --remove) and run it. It keeps a qq
                 checkout with local work git can see (files git status lists, commits on no remote
                 branch, stashes, other worktrees) or that git cannot check, keeps the qq guide's
                 demo folders, and never touches a ~/.xo that is not a venv
  --dry-run      print the commands and run nothing
  --help         this text`;

/**
 * @typedef {{ ask: (q: string) => Promise<string>, close: () => void }} Prompt
 * @typedef {{ env: NodeJS.ProcessEnv, platform: string, tty: boolean, prompt: () => Promise<Prompt>,
 *   run: Read, runStep: typeof runStep, latest?: string | null,
 *   out: (s: string) => void, err: (s: string) => void }} Io
 */

/** The real terminal. @returns {Io} */
function realIo() {
  return {
    env: process.env, platform: process.platform, tty: !!(process.stdin.isTTY && process.stdout.isTTY),
    prompt: async () => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return { ask: (q) => rl.question(q), close: () => rl.close() };
    },
    run: read, runStep, out: (s) => console.log(s), err: (s) => console.error(s),
  };
}

/** Ask until the answer starts with one key's letter; Enter takes the first. @param {Prompt} p @param {string} q @param {string[]} keys */
async function choose(p, q, keys) {
  for (;;) {
    const a = (await p.ask(q)).trim().toLowerCase();
    if (!a) return keys[0];
    const hit = keys.find((k) => k[0] === a[0]);
    if (hit) return hit;
  }
}

/**
 * The install subcommand. Exit codes as the rest of qq-setup: 0 done, 1 stopped or not ready, 2 error.
 * @param {string[]} argv  the arguments after "install"
 * @param {Io} [io]
 */
export async function main(argv, io = realIo()) {
  const { out, err } = io;
  /** @type {{ only: ("qq" | "xo")[], update: boolean, remove: boolean, yes: boolean, dryRun: boolean }} */
  const f = { only: ["qq", "xo"], update: false, remove: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return out(USAGE), 0;
    else if (a === "--update") f.update = true;
    else if (a === "--remove") f.remove = true;
    else if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--dry-run") f.dryRun = true;
    else if (a === "--only" && (argv[i + 1] === "qq" || argv[i + 1] === "xo")) f.only = [/** @type {"qq" | "xo"} */ (argv[++i])];
    else return err(`qq-setup install: unknown option ${a}${a === "--only" ? " (use --only qq or --only xo)" : ""}\n\n${USAGE}`), 2;
  }
  if (f.update && f.remove) return err("qq-setup install: --update and --remove do not go together"), 2;
  const windows = io.platform === "win32";
  if (windows) {
    if (f.only.length === 1 && f.only[0] === "qq") return err(`qq-setup install: ${windowsNote(io.env, process.cwd())}`), 1;
    // qq does not run on Windows: only xo is looked at and asked about.
    f.only = ["xo"];
  }

  // Every step names the home folder (~, or %USERPROFILE% on Windows): a relative one would aim the
  // deletes at the current folder.
  const home = windows ? io.env.USERPROFILE : io.env.HOME;
  if (!home || !(windows ? win32.isAbsolute(home) : isAbsolute(home))) {
    return err(`qq-setup install: ${windows ? "USERPROFILE" : "HOME"} must be set to an absolute path`), 2;
  }
  out("Looking at what is installed...");
  const state = await detect({ home, latest: io.latest, run: io.run, platform: io.platform });
  if (windows) out(`  qq: ${windowsNote(io.env, process.cwd())}`);
  for (const line of describe(state)) out(line);
  const interactive = !f.yes && !f.dryRun && io.tty;
  if (!interactive && !f.yes && !f.dryRun) {
    err("\nqq-setup install: no terminal to ask in. Add --yes to run the default, or --dry-run to see it.");
    return 1;
  }

  const opened = interactive ? await io.prompt() : null;
  let open = !!opened;
  const prompt = opened && { ask: opened.ask, close: () => { if (open) opened.close(); open = false; } };
  // Open only while asking: the steps get the terminal back as it was (a step like xo logout reads a line).
  /** @type {{ qq: Action, xo: Action }} */
  const actions = { qq: "keep", xo: "keep" };
  /** @type {string[]} */
  const demo = [];
  let go = !interactive;
  try {
    for (const tool of f.only) {
      const t = state[tool];
      const work = tool === "qq" ? state.qq.localWork : null;
      const note = tool === "xo" ? state.xo.note : null;
      if (tool === "xo" && state.xo.foreign) {
        out("  xo: ~/.xo is not an xo install, so it is left alone. Move it away first to install xo there.");
        continue;
      }
      if (work) out(`  ${tool}: ~/qq-tools/depot has ${work}; reinstalling, updating or removing qq deletes them.`);
      if (note) out(`  ${tool}: ${note}.`);
      if (!prompt || f.update || f.remove) {
        actions[tool] = defaultAction(t, f);
        if (work && (f.update || f.remove)) out(`  ${tool}: kept. Run without --${f.update ? "update" : "remove"} to choose.`);
      } else if (t.broken) {
        // With local work, Enter keeps it.
        const a = work
          ? await choose(prompt, `${tool} is there but not working. Keep, reinstall or delete it? [K/r/d] `, ["keep", "reinstall", "delete"])
          : await choose(prompt, `${tool} is there but not working. Reinstall, delete or keep it? [R/d/k] `, ["reinstall", "delete", "keep"]);
        actions[tool] = a === "reinstall" ? "install" : a === "delete" ? "remove" : "keep";
      } else if (t.installed && pathOnly(t)) {
        const a = await choose(prompt, `${tool} is installed but not on PATH. Add the PATH line, update, remove or keep it? [A/u/r/k] `, ["add", "update", "remove", "keep"]);
        actions[tool] = a === "add" ? "path" : /** @type {Action} */ (a);
      } else if (!t.installed) {
        // While removing something, Enter installs nothing.
        const removing = Object.values(actions).includes("remove");
        actions[tool] = (await choose(prompt, removing ? `Install ${tool}? [y/N] ` : `Install ${tool}? [Y/n] `,
          removing ? ["no", "yes"] : ["yes", "no"])) === "yes" ? "install" : "keep";
      } else if (t.behind.length && !work) {
        out(`  ${tool}: ${t.behind.join("; ")}`);
        actions[tool] = /** @type {Action} */ (await choose(prompt, `${tool} is installed. Update, remove or keep it? [U/r/k] `, ["update", "remove", "keep"]));
      } else {
        actions[tool] = /** @type {Action} */ (await choose(prompt,
          `${tool} is installed${work || note ? "" : " and up to date"}. Keep, update (reinstall) or remove it? [K/u/r] `, ["keep", "update", "remove"]));
      }
    }
    // The guide's demo folders hold the user's own clones: delete each only on a yes, never under --yes.
    if (actions.qq === "remove") {
      for (const d of DEMO.filter((d) => existsSync(join(home, d)))) {
        if (prompt && (await choose(prompt, `Also delete ~/${d}, the qq guide's demo folder (your clones may be in it)? [y/N] `, ["no", "yes"])) === "yes") demo.push(d);
        else out(`  kept ~/${d}`);
      }
    }
    // The QQ_PYTHON line may serve something else too: deleted only on a yes, never under --yes.
    let pythonLine = false;
    const py = state.qq.pythonLine;
    if (actions.qq === "remove" && py) {
      const where = py.files.map((x) => `~/${x}`).join(", ");
      pythonLine = !!prompt && (await choose(prompt, `Also delete the ${py.line} line from ${where} (unless something else uses that Python)? [y/N] `, ["no", "yes"])) === "yes";
    }

    const { steps, stop, python, env } = await prepare(actions, state, { demo, pythonLine, env: io.env, platform: io.platform, run: io.run });
    if (stop) return err(`\nqq-setup install: ${stop}`), 1;
    if (!steps.length) return out("\nNothing to do."), 0;
    out(`\n${f.dryRun ? "It would run" : "It will run"} these, in order:`);
    steps.forEach((s, i) => out(`  ${i + 1}. ${s.what}:\n     ${s.cmd}`));
    if (python.ok && python.cmd && python.cmd !== "python3") out(`With QQ_PYTHON=${python.cmd} (${python.version}).`);
    if (f.dryRun) return out("\nDry run: nothing was run."), 0;
    if (prompt) go = (await choose(prompt, "\nRun them now? [y/N] ", ["no", "yes"])) === "yes";
    if (!go) return out("Nothing was run."), 1;
    prompt?.close();

    for (const [i, s] of steps.entries()) {
      out(`\n[${i + 1}/${steps.length}] ${s.what}`);
      const code = await io.runStep(s.cmd, env);
      if (code !== 0) {
        err(`\nqq-setup install: step ${i + 1} exited ${code}; the steps after it did not run. Fix it, then run this again (every step is safe to run again).`);
        return 2;
      }
    }
    out("\nDone. Open a new terminal so PATH (and QQ_PYTHON) take effect.");
    if (actions.xo === "install") out("Then log xo in with your XO API key:  xo login");
    for (const line of afterNotes(actions, home)) out(line);
    return 0;
  } finally {
    prompt?.close();
  }
}
