// @ts-check
// qq-setup install: install, update or remove qq (with qqsync) and xo on this machine. It looks at what
// is already here, asks what to do with each, shows the exact commands, and runs them only after a yes.
// It writes only under your home directory (~/qq-tools, ~/.xo, your shell's startup file) and never
// writes to GitHub. The commands are the qq guide's and the xo quickstart's, copied unchanged where
// they exist (tests/fixtures/qq-guide-*.txt and xo-quickstart.txt; scripts/check-guide.mjs checks them).

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTALL, MAC_PYTHON } from "./tools.mjs";

/** Remove qq: the qq guide's "Remove everything" commands (quirq-ai/docs content/docs/install.mdx, at d02c27f). */
export const QQ_REMOVE = [
  "( chmod -R u+w ~/.cache/qq 2>/dev/null; rm -rf ~/qq-tools ~/qq-try ~/qq-ci-venv ~/.cache/qq )",
  "( for f in ~/.bashrc ~/.bash_profile ~/.bash_login ~/.profile ~/.zshrc; do grep -qsxF 'export PATH=\"$HOME/qq-tools/bin:$PATH\"' \"$f\" || continue; awk '$0 == \"export PATH=\\\"$HOME/qq-tools/bin:$PATH\\\"\" { if (b > 0) b--; next } /^$/ { b++; next } { while (b > 0) { print \"\"; b-- } print } END { while (b > 0) { print \"\"; b-- } }' \"$f\" >| \"$f.qq-tmp\" || exit 1; if [ -L \"$f\" ] || grep -q '[^[:space:]]' \"$f.qq-tmp\"; then cat \"$f.qq-tmp\" >| \"$f\" || exit 1; rm -f \"$f.qq-tmp\"; echo \"removed the qq-tools/bin line from $f\"; else rm -f \"$f\" \"$f.qq-tmp\"; echo \"deleted $f, which held only that line\"; fi; done )",
];

/** The commit of xo the xo quickstart installs (quirq-ai/xo docs/quickstart.md:18, at 05d910b). */
export const XO_PIN = "3699cdc08c08da7ad8387837346fb18fea0d39a2";
export const XO_SPEC = `quirq-xo @ git+https://github.com/quirq-ai/xo@${XO_PIN}`;
export const XO_PATH_LINE = 'export PATH="$HOME/.xo/bin:$PATH"';
const QQ_PATH_LINE = 'export PATH="$HOME/qq-tools/bin:$PATH"';
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

export const XO = {
  /** The quickstart's install, as the qq guide's steps are written: in ( … ), with the Python qq uses. */
  install: { what: "Install xo (pinned to the commit the xo quickstart installs)",
    cmd: `( set -e; "\${QQ_PYTHON:-python3}" -m venv ~/.xo; ~/.xo/bin/pip install -q --disable-pip-version-check "${XO_SPEC}"; ~/.xo/bin/xo --version )` },
  path: { what: "Put xo on your PATH (the same startup file as qq's PATH line; open a new terminal afterwards)",
    cmd: `( ${PICK_RC}; { grep -qsxF '${XO_PATH_LINE}' "$rc" || printf '\\n${XO_PATH_LINE}\\n' >> "$rc"; } && echo "~/.xo/bin is on PATH in $rc; open a new terminal" )` },
  /** The quickstart's update, at the pinned commit. */
  update: { what: "Update xo to the pinned commit",
    cmd: `~/.xo/bin/pip install --force-reinstall --no-deps "${XO_SPEC}"` },
  remove: [
    { what: "Log xo out: deletes the saved XO key (xo asks before logging gh out too)", cmd: "~/.xo/bin/xo logout" },
    { what: "Delete xo's folder", cmd: "rm -rf ~/.xo" },
    { what: "Remove xo's PATH line", cmd: removeLineCmd(XO_PATH_LINE, ".xo/bin") },
  ],
};

/** The sync commit qq's guide installs qqsync at (INSTALL[1]). */
export const SYNC_PIN = /** @type {string} */ (/sync@([0-9a-f]{40})/.exec(INSTALL[1].cmd)?.[1]);

/**
 * @typedef {{ installed: boolean, commit: string | null, latest: string | null, syncPin: string | null,
 *   onPath: boolean, behind: string[] }} QqState
 * @typedef {{ installed: boolean, pin: string | null, onPath: boolean, behind: string[] }} XoState
 * @typedef {{ cmd: string | null, version: string | null, ok: boolean, persist: boolean }} PythonPick
 */

/**
 * Run a program and return its stdout, or null when it is missing, fails or takes too long.
 * @param {string} file @param {string[]} args @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string | null>}
 */
export function read(file, args, env = process.env) {
  return new Promise((ok) => {
    execFile(file, args, { timeout: 30_000, env }, (err, stdout) => ok(err ? null : String(stdout)));
  });
}

/** True when a startup file in home holds exactly this line. @param {string} home @param {string} line */
function lineIn(home, line) {
  return RC_FILES.some((f) => {
    try {
      return readFileSync(join(home, f), "utf8").split("\n").includes(line);
    } catch {
      return false;
    }
  });
}

/** The commit a pip venv installed a git package at. @param {string | null} freeze @param {string} pkg */
export function pinIn(freeze, pkg) {
  const m = new RegExp(`^${pkg} @ git\\+https://github\\.com/quirq-ai/[\\w.-]+@([0-9a-f]{40})$`, "m").exec(freeze ?? "");
  return m ? m[1] : null;
}

/**
 * Look at what is installed. Reads only: files under home, `git rev-parse` in qq's checkout, `pip freeze`
 * in the two venvs and, unless `latest` is given, `git ls-remote` for qq's newest commit.
 * @param {{ home: string, latest?: string | null, run?: typeof read }} o
 * @returns {Promise<{ qq: QqState, xo: XoState }>}
 */
export async function detect({ home, latest, run = read }) {
  const depot = join(home, "qq-tools", "depot");
  const qqHere = existsSync(join(depot, "bin", "qq"));
  const commit = qqHere ? (await run("git", ["-C", depot, "rev-parse", "HEAD"]))?.trim() || null : null;
  if (qqHere && latest === undefined) {
    latest = (await run("git", ["ls-remote", "https://github.com/quirq-ai/qq", "HEAD"]))?.split(/\s/)[0] || null;
  }
  const syncPip = join(home, "qq-tools", "qqsync", "bin", "pip");
  const syncPin = existsSync(syncPip) ? pinIn(await run(syncPip, ["freeze", "--disable-pip-version-check"]), "qqsync") : null;
  const qqOnPath = existsSync(join(home, "qq-tools", "bin", "qq")) && lineIn(home, QQ_PATH_LINE);
  /** @type {string[]} */
  const qqBehind = [];
  if (qqHere) {
    if (latest && commit && latest !== commit) qqBehind.push(`qq ${commit.slice(0, 7)} is behind ${latest.slice(0, 7)}`);
    if (syncPin !== SYNC_PIN) qqBehind.push(syncPin ? `qqsync is at ${syncPin.slice(0, 7)}, not ${SYNC_PIN.slice(0, 7)}` : "qqsync is not installed");
    if (!qqOnPath) qqBehind.push("not on PATH");
  }

  const xoPip = join(home, ".xo", "bin", "pip");
  const xoHere = existsSync(join(home, ".xo", "bin", "xo"));
  const pin = xoHere && existsSync(xoPip) ? pinIn(await run(xoPip, ["freeze", "--disable-pip-version-check"]), "quirq-xo") : null;
  const xoOnPath = lineIn(home, XO_PATH_LINE);
  /** @type {string[]} */
  const xoBehind = [];
  if (xoHere) {
    if (pin !== XO_PIN) xoBehind.push(pin ? `xo is at ${pin.slice(0, 7)}, not ${XO_PIN.slice(0, 7)}` : "xo's commit is unknown");
    if (!xoOnPath) xoBehind.push("not on PATH");
  }
  return {
    qq: { installed: qqHere, commit, latest: latest ?? null, syncPin, onPath: qqOnPath, behind: qqBehind },
    xo: { installed: xoHere, pin, onPath: xoOnPath, behind: xoBehind },
  };
}

/** @param {string | null} out  `python --version` output */
export function pythonOk(out) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out ?? "");
  if (!m) return false;
  const [maj, min, mic] = m.slice(1).map(Number);
  return maj > 3 || (maj === 3 && (min > 11 || (min === 11 && mic >= 4)));
}

/**
 * The Python to make qq's and xo's venvs with: QQ_PYTHON when set, else python3, else the newest
 * python3.N on PATH. `persist` says qq needs QQ_PYTHON in the startup file to find it later.
 * @param {NodeJS.ProcessEnv} env @param {typeof read} [run] @returns {Promise<PythonPick>}
 */
export async function pickPython(env, run = read) {
  if (env.QQ_PYTHON) {
    const version = (await run(env.QQ_PYTHON, ["--version"], env))?.trim() || null;
    return { cmd: env.QQ_PYTHON, version, ok: pythonOk(version), persist: false };
  }
  /** @type {string | null} */
  let first = null;
  for (const cmd of ["python3", "python3.14", "python3.13", "python3.12", "python3.11"]) {
    const version = (await run(cmd, ["--version"], env))?.trim() || null;
    if (cmd === "python3") first = version;
    if (pythonOk(version)) return { cmd, version, ok: true, persist: cmd !== "python3" };
  }
  return { cmd: null, version: first, ok: false, persist: false };
}

/** Write QQ_PYTHON to the startup file the PATH step uses, unless one is there. @param {string} py */
export function persistPython(py) {
  if (!/^python3\.\d+$/.test(py)) throw new Error(`not a python3.N name: ${py}`);
  return { what: `Tell qq to use ${py} (adds export QQ_PYTHON=${py} to your shell's startup file)`,
    cmd: `( ${PICK_RC}; { grep -qs 'QQ_PYTHON=' "$rc" || printf '\\nexport QQ_PYTHON=${py}\\n' >> "$rc"; } && echo "QQ_PYTHON is set in $rc" )` };
}

/** @typedef {"install" | "update" | "remove" | "keep"} Action */

/**
 * The steps for the chosen actions, in order: Python first when an install needs it, then qq, then xo.
 * @param {{ qq: Action, xo: Action }} actions
 * @param {{ qq: QqState, xo: XoState }} state
 * @param {PythonPick} python
 * @param {string} platform
 * @returns {{ steps: Step[], stop: string | null }}  stop: why nothing can run
 */
export function planSteps(actions, state, python, platform) {
  /** @type {Step[]} */
  const steps = [];
  const xoFresh = actions.xo === "install" || (actions.xo === "update" && !state.xo.installed);
  const needsPython = actions.qq === "install" || actions.qq === "update" || xoFresh;
  if (needsPython && !python.ok) {
    if (platform !== "darwin") {
      return { steps: [], stop: `qq and xo need Python 3.11.4 or newer (found ${python.version ?? "none"}): install one, and set QQ_PYTHON to it unless it is python3` };
    }
    steps.push(MAC_PYTHON);
  } else if (needsPython && python.persist && python.cmd && (actions.qq === "install" || actions.qq === "update")) {
    steps.push(persistPython(python.cmd));
  }
  if (actions.qq === "install" || actions.qq === "update") steps.push(...INSTALL);
  if (actions.qq === "remove") steps.push({ what: "Remove qq, qqsync, the qq guide's demo folders and qq's cache", cmd: QQ_REMOVE[0] },
    { what: "Remove qq's PATH line", cmd: QQ_REMOVE[1] });
  if (xoFresh) steps.push(XO.install);
  else if (actions.xo === "update") steps.push(XO.update);
  if ((actions.xo === "install" || actions.xo === "update") && !state.xo.onPath) steps.push(XO.path);
  if (actions.xo === "remove") steps.push(...XO.remove);
  return { steps, stop: null };
}

/** One line per tool for the terminal. @param {{ qq: QqState, xo: XoState }} s @returns {string[]} */
export function describe(s) {
  const qq = !s.qq.installed ? "not installed"
    : `installed at ${s.qq.commit?.slice(0, 7) ?? "an unknown commit"}` +
      (s.qq.latest ? (s.qq.latest === s.qq.commit ? " (the newest)" : `, newest is ${s.qq.latest.slice(0, 7)}`) : " (could not check the newest)") +
      `; qqsync ${s.qq.syncPin ? `at ${s.qq.syncPin.slice(0, 7)}` : "missing"}` +
      `; ${s.qq.onPath ? "on PATH" : "not on PATH"}` + (s.qq.behind.length ? ": update available" : ": up to date");
  const xo = !s.xo.installed ? "not installed"
    : `installed at ${s.xo.pin?.slice(0, 7) ?? "an unknown commit"}; ${s.xo.onPath ? "on PATH" : "not on PATH"}` +
      (s.xo.behind.length ? `: update available (setup's pin is ${XO_PIN.slice(0, 7)})` : ": up to date");
  return [`  qq  ${qq}`, `  xo  ${xo}`];
}

/**
 * The action for one tool with no question asked: --remove removes, otherwise an absent tool is
 * installed and one that is behind is updated (also with --update, which reruns an up-to-date one).
 * @param {{ installed: boolean, behind: string[] }} t
 * @param {{ remove?: boolean, update?: boolean }} flags
 * @returns {Action}
 */
export function defaultAction(t, flags) {
  if (flags.remove) return t.installed ? "remove" : "keep";
  if (!t.installed) return "install";
  return t.behind.length || flags.update ? "update" : "keep";
}

/** Run one step in sh, showing its output; resolves to its exit code. @param {string} cmd @param {NodeJS.ProcessEnv} env */
export function runStep(cmd, env) {
  return new Promise((ok) => {
    const child = spawn("/bin/sh", ["-c", cmd], { stdio: "inherit", env });
    child.on("error", () => ok(127));
    child.on("exit", (code, signal) => ok(code ?? (signal ? 128 : 1)));
  });
}

const USAGE = `qq-setup install: install, update or remove qq (with qqsync) and xo on this machine.

  npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/<commit> install [--only qq|xo] [--update | --remove] [--yes] [--dry-run]

It shows what is installed, asks what to do with each tool (install what is missing; update, remove or
keep what is there), prints the exact commands, and runs them after you say yes.

  --only qq|xo   only this tool (qq includes qqsync); default both
  --update       update what is installed (rerun its install), install what is missing
  --remove       remove the tools instead
  --yes          no questions: do the default (or --update / --remove) and run it
  --dry-run      print the commands and run nothing
  --help         this text`;

/** @param {import("node:readline/promises").Interface | null} rl @param {string} q @param {string[]} keys */
async function ask(rl, q, keys) {
  if (!rl) return keys[0];
  for (;;) {
    const a = (await rl.question(q)).trim().toLowerCase();
    if (!a) return keys[0];
    const hit = keys.find((k) => k[0] === a[0]);
    if (hit) return hit;
  }
}

/**
 * The install subcommand. Exit codes as the rest of qq-setup: 0 done, 1 stopped or not ready, 2 error.
 * @param {string[]} argv  the arguments after "install"
 */
export async function main(argv) {
  /** @type {{ only: ("qq" | "xo")[], update: boolean, remove: boolean, yes: boolean, dryRun: boolean }} */
  const f = { only: ["qq", "xo"], update: false, remove: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return console.log(USAGE), 0;
    else if (a === "--update") f.update = true;
    else if (a === "--remove") f.remove = true;
    else if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--dry-run") f.dryRun = true;
    else if (a === "--only" && (argv[i + 1] === "qq" || argv[i + 1] === "xo")) f.only = [/** @type {"qq" | "xo"} */ (argv[++i])];
    else return console.error(`qq-setup install: unknown option ${a}${a === "--only" ? " (use --only qq or --only xo)" : ""}\n\n${USAGE}`), 2;
  }
  if (f.update && f.remove) return console.error("qq-setup install: --update and --remove do not go together"), 2;
  if (process.platform === "win32") return console.error("qq-setup install: qq and xo install on Linux and macOS only"), 1;

  const home = process.env.HOME;
  if (!home) return console.error("qq-setup install: HOME is not set"), 2;
  console.log("Looking at what is installed...");
  const state = await detect({ home });
  for (const line of describe(state)) console.log(line);

  const interactive = !f.yes && !f.dryRun && process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive && !f.yes && !f.dryRun) {
    console.error("\nqq-setup install: no terminal to ask in. Add --yes to run the default, or --dry-run to see it.");
    return 1;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    /** @type {{ qq: Action, xo: Action }} */
    const actions = { qq: "keep", xo: "keep" };
    for (const tool of f.only) {
      const t = state[tool];
      const dflt = defaultAction(t, f);
      if (!rl || f.update || f.remove) actions[tool] = dflt;
      else if (!t.installed) actions[tool] = /** @type {Action} */ (await ask(rl, `Install ${tool}? [Y/n] `, ["yes", "no"]) === "yes" ? "install" : "keep");
      else if (t.behind.length) {
        console.log(`  ${tool}: ${t.behind.join("; ")}`);
        actions[tool] = /** @type {Action} */ (await ask(rl, `${tool} is installed. Update, remove or keep it? [U/r/k] `, ["update", "remove", "keep"]));
      } else actions[tool] = /** @type {Action} */ (await ask(rl, `${tool} is installed and up to date. Keep, update (reinstall) or remove it? [K/u/r] `, ["keep", "update", "remove"]));
    }

    const python = await pickPython(process.env);
    const { steps, stop } = planSteps(actions, state, python, process.platform);
    if (stop) return console.error(`\nqq-setup install: ${stop}`), 1;
    if (!steps.length) return console.log("\nNothing to do."), 0;
    console.log(`\n${f.dryRun ? "It would run" : "It will run"} these, in order:`);
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.what}:\n     ${s.cmd}`));
    if (python.ok && python.cmd !== "python3") console.log(`With QQ_PYTHON=${python.cmd} (${python.version}).`);
    if (f.dryRun) return console.log("\nDry run: nothing was run."), 0;
    if (rl && (await ask(rl, "\nRun them now? [y/N] ", ["no", "yes"])) !== "yes") return console.log("Nothing was run."), 1;

    // The Python the steps use: the one picked, or brew's python3.13 once the Mac step has run.
    const py = python.ok ? python.cmd : process.platform === "darwin" ? "python3.13" : null;
    const env = py ? { ...process.env, QQ_PYTHON: py } : process.env;
    for (const [i, s] of steps.entries()) {
      console.log(`\n[${i + 1}/${steps.length}] ${s.what}`);
      const code = await runStep(s.cmd, env);
      if (code !== 0) {
        console.error(`\nqq-setup install: step ${i + 1} exited ${code}; the steps after it did not run. Fix it, then run this again (every step is safe to run again).`);
        return 2;
      }
    }
    console.log("\nDone. Open a new terminal so PATH (and QQ_PYTHON) take effect.");
    if (actions.xo === "install") console.log("Then log xo in with your XO API key:  xo login");
    return 0;
  } finally {
    rl?.close();
  }
}
