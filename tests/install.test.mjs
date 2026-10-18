// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BREW_PYTHON, cleanTmp, DEMO, defaultAction, describe, detect, main, pickPython, pinIn, planSteps, pythonOk,
  QQ_REMOVE, QQ_REMOVE_TOOLS, removeLineCmd, SYNC_PIN, XO, XO_PATH_LINE, XO_PIN, XO_SPEC,
} from "../cli/install.mjs";
import { INSTALL, MAC_PYTHON } from "../cli/tools.mjs";

/** The commands of a fixture, and the commit its header names. @param {string} name */
function fixture(name) {
  const [head1, , ...cmds] = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replace(/\n$/, "").split("\n");
  const sha = /at ([0-9a-f]{40}),$/.exec(head1)?.[1];
  assert.ok(sha, `${name} line 1 must name a full commit`);
  return { cmds, sha };
}
const source = readFileSync(new URL("../cli/install.mjs", import.meta.url), "utf8");

test("qq's remove commands are the qq guide's, at the commit install.mjs names, less what it must not delete", () => {
  const { cmds, sha } = fixture("qq-guide-remove.txt");
  assert.deepEqual(QQ_REMOVE, cmds);
  assert.ok(source.includes(`install.mdx, at ${sha.slice(0, 7)})`), `cli/install.mjs must name docs commit ${sha.slice(0, 7)}`);
  // The demo folders come out of the first command and are asked about one by one.
  assert.equal(QQ_REMOVE_TOOLS, "( chmod -R u+w ~/.cache/qq 2>/dev/null; rm -rf ~/qq-tools ~/.cache/qq )");
  assert.deepEqual(DEMO.map((d) => `~/${d}`), ["~/qq-try", "~/qq-ci-venv"]);
  // The same template removes xo's line, so it is the guide's command with only the line changed;
  // cleanTmp changes exactly the two places that could leave $f.qq-tmp behind.
  assert.equal(removeLineCmd('export PATH="$HOME/qq-tools/bin:$PATH"', "qq-tools/bin"), QQ_REMOVE[1]);
  const cleaned = cleanTmp(QQ_REMOVE[1]);
  assert.equal(cleaned.split('{ rm -f "$f.qq-tmp"; exit 1; };').length, 3);
  assert.doesNotMatch(cleaned, /\|\| exit 1;/);
  assert.ok(XO.remove[2].cmd.includes(`grep -qsxF '${XO_PATH_LINE}'`));
});

test("xo's commands follow the xo quickstart at the commit install.mjs names", () => {
  const { cmds: [pipLine, update, logout, rm], sha } = fixture("xo-quickstart.txt");
  assert.ok(source.includes(`quickstart.md:18, at ${sha.slice(0, 7)})`), `cli/install.mjs must name xo commit ${sha.slice(0, 7)}`);
  assert.ok(pipLine.includes(`"${XO_SPEC}"`), "the pin is the quickstart's");
  assert.ok(XO.install.cmd.includes(`"${XO_SPEC}"`) && XO.install.cmd.includes("-m venv --clear ~/.xo"));
  assert.equal(XO.update.cmd, update.replace("NEW_SHA", XO_PIN));
  assert.ok(XO.remove[0].cmd.startsWith(`( ~/.xo/bin/${logout} || {`), "by path: xo may not be on PATH in this shell");
  assert.match(XO.remove[0].cmd, /rm -f "\$c\/xo\/credentials" "\$c\/xo\/services"/);
  assert.equal(XO.remove[1].cmd, rm);
  assert.equal(SYNC_PIN, /sync@([0-9a-f]{40})/.exec(INSTALL[1].cmd)?.[1]);
  assert.equal(BREW_PYTHON.cmd, "brew install python@3.13");
});

test("zsh-safe: no comment or history characters in anything install runs", () => {
  const all = [QQ_REMOVE_TOOLS, cleanTmp(QQ_REMOVE[1]), XO.install.cmd, XO.path.cmd, XO.update.cmd, ...XO.remove.map((s) => s.cmd)];
  for (const c of all) assert.doesNotMatch(c, /[#!]/, c);
});

test("pinIn and pythonOk", () => {
  const freeze = `pip==25.0\nquirq-xo @ git+https://github.com/quirq-ai/xo@${XO_PIN}\n`;
  assert.equal(pinIn(freeze, "quirq-xo"), XO_PIN);
  assert.equal(pinIn(freeze, "qqsync"), null);
  assert.equal(pinIn(`quirq-xo @ git+https://evil.example/quirq-ai/xo@${XO_PIN}`, "quirq-xo"), null);
  assert.ok(pythonOk("Python 3.11.4") && pythonOk("Python 3.13.16") && pythonOk("Python 4.0.0"));
  assert.ok(!pythonOk("Python 3.11.3") && !pythonOk("Python 3.9.6") && !pythonOk(null));
  // xo alone needs 3.11: Debian 12's 3.11.2 is fine for it.
  assert.ok(pythonOk("Python 3.11.2", [3, 11, 0]) && !pythonOk("Python 3.10.12", [3, 11, 0]));
});

/** @param {Record<string, string>} have @returns {any} */
const runWith = (have) => async (/** @type {string} */ cmd) => have[cmd] ?? null;

test("pickPython: QQ_PYTHON, else python3, else the newest python3.N, which qq must be told about", async () => {
  const qq = [3, 11, 4];
  assert.deepEqual(await pickPython({ QQ_PYTHON: "python3.12" }, qq, runWith({ "python3.12": "Python 3.12.1" })),
    { cmd: "python3.12", version: "Python 3.12.1", ok: true, persist: false });
  assert.deepEqual(await pickPython({}, qq, runWith({ python3: "Python 3.13.16" })), { cmd: "python3", version: "Python 3.13.16", ok: true, persist: false });
  // A stock Mac: python3 is 3.9 and brew added python3.13.
  assert.deepEqual(await pickPython({}, qq, runWith({ python3: "Python 3.9.6", "python3.13": "Python 3.13.16" })),
    { cmd: "python3.13", version: "Python 3.13.16", ok: true, persist: true });
  assert.deepEqual(await pickPython({}, qq, runWith({ python3: "Python 3.9.6" })), { cmd: null, version: "Python 3.9.6", ok: false, persist: false });
  assert.equal((await pickPython({}, [3, 11, 0], runWith({ python3: "Python 3.11.2" }))).ok, true);
});

/** @type {import("../cli/install.mjs").State} */
const none = { qq: { installed: false, broken: false, commit: null, latest: null, syncPin: null, onPath: false, behind: [], localWork: null },
  xo: { installed: false, broken: false, pin: null, onPath: false, behind: [], note: null } };
const here = { qq: { ...none.qq, installed: true, onPath: true }, xo: { ...none.xo, installed: true, onPath: true, pin: XO_PIN } };
const py = { cmd: "python3", version: "Python 3.13.16", ok: true, persist: false };
const linux = { python: py, platform: "linux", git: true };

test("planSteps: install, update and remove, in order", () => {
  assert.deepEqual(planSteps({ qq: "install", xo: "install" }, none, linux).steps, [...INSTALL, XO.install, XO.path]);
  assert.deepEqual(planSteps({ qq: "keep", xo: "update" }, here, linux).steps, [XO.update]);
  assert.deepEqual(planSteps({ qq: "update", xo: "keep" }, here, linux).steps, INSTALL);
  const gone = planSteps({ qq: "remove", xo: "remove" }, here, linux).steps.map((s) => s.cmd);
  assert.deepEqual(gone, [QQ_REMOVE_TOOLS, cleanTmp(QQ_REMOVE[1]), ...XO.remove.map((s) => s.cmd)]);
  const withDemo = planSteps({ qq: "remove", xo: "keep" }, here, { ...linux, demo: ["qq-try"] }).steps.map((s) => s.cmd);
  assert.deepEqual(withDemo, [QQ_REMOVE_TOOLS, "rm -rf ~/qq-try", cleanTmp(QQ_REMOVE[1])]);
  assert.deepEqual(planSteps({ qq: "keep", xo: "keep" }, here, linux).steps, []);
  assert.match(planSteps({ qq: "install", xo: "keep" }, none, { ...linux, platform: "darwin", git: false }).stop ?? "", /git is needed.*xcode-select --install/);
  // Removing needs neither git nor Python.
  assert.equal(planSteps({ qq: "remove", xo: "remove" }, here, { python: { ...py, ok: false }, platform: "linux", git: false }).stop, null);
});

test("planSteps: Python comes first when an install needs it", () => {
  const old = { cmd: null, version: "Python 3.9.6", ok: false, persist: false };
  assert.equal(planSteps({ qq: "install", xo: "keep" }, none, { python: old, platform: "darwin", git: true }).steps[0], MAC_PYTHON);
  // xo alone on a Mac: brew's Python, but no QQ_PYTHON line.
  assert.deepEqual(planSteps({ qq: "keep", xo: "install" }, none, { python: old, platform: "darwin", git: true }).steps,
    [BREW_PYTHON, XO.install, XO.path]);
  assert.match(planSteps({ qq: "install", xo: "keep" }, none, { python: old, platform: "linux", git: true }).stop ?? "",
    /qq needs Python 3\.11\.4 or newer \(found Python 3\.9\.6\)/);
  assert.match(planSteps({ qq: "keep", xo: "install" }, none, { python: old, platform: "linux", git: true }).stop ?? "", /xo needs Python 3\.11 or newer/);
  const brewed = planSteps({ qq: "install", xo: "keep" }, none, { python: { cmd: "python3.13", version: "Python 3.13.16", ok: true, persist: true }, platform: "darwin", git: true }).steps;
  assert.match(brewed[0].cmd, /grep -qs 'QQ_PYTHON=' "\$rc" \|\| printf '\\nexport QQ_PYTHON=python3\.13\\n'/);
  assert.deepEqual(brewed.slice(1), INSTALL);
  assert.deepEqual(planSteps({ qq: "keep", xo: "install" }, none, { python: { cmd: "python3.13", version: "x", ok: true, persist: true }, platform: "darwin", git: true }).steps,
    [XO.install, XO.path]);
});

test("defaultAction: install what is missing or broken, update what is behind, keep the rest and local work", () => {
  const t = { installed: true, broken: false, behind: [], localWork: null };
  assert.equal(defaultAction({ ...t, installed: false }, {}), "install");
  assert.equal(defaultAction({ ...t, installed: false, broken: true }, {}), "install");
  assert.equal(defaultAction({ ...t, behind: ["x"] }, {}), "update");
  assert.equal(defaultAction(t, {}), "keep");
  assert.equal(defaultAction(t, { update: true }), "update");
  assert.equal(defaultAction(t, { remove: true }), "remove");
  assert.equal(defaultAction({ ...t, installed: false, broken: true }, { remove: true }), "remove");
  assert.equal(defaultAction({ ...t, installed: false }, { remove: true }), "keep");
  for (const flags of [{}, { update: true }, { remove: true }]) assert.equal(defaultAction({ ...t, behind: ["x"], localWork: "1 local commit" }, flags), "keep");
});

/** A home with qq, qqsync and xo as an install leaves them. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-home-"));
  for (const d of ["qq-tools/depot/bin", "qq-tools/qqsync/bin", "qq-tools/bin", ".xo/bin"]) mkdirSync(join(home, d), { recursive: true });
  for (const f of ["qq-tools/depot/bin/qq", "qq-tools/qqsync/bin/pip", "qq-tools/bin/qq", ".xo/bin/xo", ".xo/bin/pip"]) writeFileSync(join(home, f), "");
  return home;
}

/** run() for detect: git answers per subcommand, pip freeze per venv, xo --version. @returns {any} */
function fakeRun({ head = "a".repeat(40), status = "", ahead = "0", xoPin = XO_PIN, xoRuns = true } = {}) {
  return async (/** @type {string} */ file, /** @type {string[]} */ args) => {
    if (file === "git") return args.includes("rev-parse") ? `${head}\n` : args.includes("status") ? status : args.includes("rev-list") ? `${ahead}\n` : "git version 2.50";
    if (file.endsWith("/xo")) return xoRuns ? "xo 0.1.0\n" : null;
    if (file.includes("qqsync")) return `qqsync @ git+https://github.com/quirq-ai/sync@${SYNC_PIN}\n`;
    if (file.endsWith("/pip")) return `quirq-xo @ git+https://github.com/quirq-ai/xo@${xoPin}\n`;
    return file === "python3" ? "Python 3.13.16" : null;
  };
}

test("detect reads what a previous install left", async () => {
  const home = fakeHome();
  // A PATH line the guide's own guard accepts (grep 'qq-tools/bin:') counts, exact or not.
  writeFileSync(join(home, ".zshrc"), `\nexport PATH=$HOME/qq-tools/bin:$PATH\n`);
  const old = "1".repeat(40);
  const s = await detect({ home, latest: "b".repeat(40), run: fakeRun({ xoPin: old }) });
  assert.deepEqual(s.qq, { installed: true, broken: false, commit: "a".repeat(40), latest: "b".repeat(40), syncPin: SYNC_PIN, onPath: true,
    behind: ["qq aaaaaaa is behind bbbbbbb"], localWork: null });
  // An xo commit other than the pin may be newer: a note, not "behind".
  assert.deepEqual(s.xo.behind, ["not on PATH"]);
  assert.match(s.xo.note ?? "", /xo is at 1111111, not setup's pin .{7}; updating would put it at/);
  const lines = describe(s);
  assert.match(lines[0], /qq {2}installed at aaaaaaa, newest is bbbbbbb; qqsync at .{7}; on PATH: update available/);
  assert.match(lines[1], /xo {2}installed at 1111111; not on PATH: not at setup's pin/);
  assert.equal(defaultAction(s.xo, {}), "update", "only because it is not on PATH");
  writeFileSync(join(home, ".zshrc"), `${XO_PATH_LINE}\nexport PATH=$HOME/qq-tools/bin:$PATH\n`);
  assert.equal(defaultAction((await detect({ home, latest: "b".repeat(40), run: fakeRun({ xoPin: old }) })).xo, {}), "keep");

  const work = await detect({ home, latest: "b".repeat(40), run: fakeRun({ status: " M bin/qq\n?? MY-NOTES.txt\n", ahead: "1" }) });
  assert.equal(work.qq.localWork, "uncommitted files and 1 local commit");
  assert.deepEqual(work.qq.behind, [], "local work is not behind");
  assert.match(describe(work)[0], /with local work \(uncommitted files and 1 local commit\)/);

  const broken = await detect({ home, latest: null, run: fakeRun({ xoRuns: false }) });
  assert.equal(broken.xo.installed, false);
  assert.equal(broken.xo.broken, true);
  assert.match(describe(broken)[1], /not working/);
  assert.deepEqual(describe(await detect({ home: mkdtempSync(join(tmpdir(), "qq-setup-empty-")), run: fakeRun() })),
    ["  qq  not installed", "  xo  not installed"]);
});

/**
 * Drive main() with scripted answers. Records each question, each step and the environment it got,
 * and whether the prompt was closed before the first step ran.
 * @param {string[]} argv @param {{ home: string, answers?: string[], tty?: boolean, platform?: string,
 *   env?: Record<string, string>, codes?: number[], run?: any }} o
 */
async function drive(argv, { home, answers = [], tty = true, platform = "linux", env = {}, codes = [], run = fakeRun() }) {
  /** @type {{ asked: string[], steps: string[], envs: NodeJS.ProcessEnv[], out: string[], closedFirst: boolean[] }} */
  const r = { asked: [], steps: [], envs: [], out: [], closedFirst: [] };
  let closed = false;
  const code = await main(argv, {
    env: { HOME: home, PATH: "/usr/bin", ...env }, platform, tty, latest: "a".repeat(40), run,
    prompt: async () => ({ ask: async (q) => (r.asked.push(q), answers.shift() ?? ""), close: () => { closed = true; } }),
    runStep: async (cmd, e) => (r.closedFirst.push(closed), r.steps.push(cmd), r.envs.push(e), codes.shift() ?? 0),
    out: (s) => r.out.push(s), err: (s) => r.out.push(s),
  });
  return { code, ...r };
}

test("main: Enter never removes, and Enter at 'Run them now?' runs nothing", async () => {
  const home = fakeHome();
  writeFileSync(join(home, ".zshrc"), `export PATH="$HOME/qq-tools/bin:$PATH"\n${XO_PATH_LINE}\n`);
  // Both up to date: Enter keeps both.
  assert.equal((await drive([], { home, answers: ["", ""] })).out.at(-1), "\nNothing to do.");
  // qq behind: Enter picks update; then Enter at the last question is no.
  const behind = await drive([], { home, answers: ["", "", ""], run: fakeRun({ head: "c".repeat(40) }) });
  assert.equal(behind.code, 1);
  assert.deepEqual(behind.steps, []);
  assert.match(behind.asked[0], /qq is installed\. Update, remove or keep it\? \[U\/r\/k\]/);
  assert.match(behind.asked.at(-1) ?? "", /Run them now\? \[y\/N\]/);
  assert.ok(behind.out.some((l) => l.includes(INSTALL[0].cmd)), "the update reruns the install");
});

test("main: the prompt is closed before any step runs, steps get QQ_PYTHON, and a failed step stops the rest", async () => {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-new-"));
  const r = await drive([], { home, answers: ["y", "y", "y"], codes: [0, 3], run: fakeRun() });
  assert.equal(r.code, 2);
  assert.deepEqual(r.steps, [INSTALL[0].cmd, INSTALL[1].cmd], "nothing after the failed step");
  assert.deepEqual(r.closedFirst, [true, true]);
  assert.equal(r.envs[0].QQ_PYTHON, "python3");
  assert.match(r.out.join("\n"), /step 2 exited 3; the steps after it did not run/);
  // A stock Mac with brew's python3.13: the steps run with it, after the line that tells qq.
  const mac = await drive(["--yes", "--only", "qq"], { home, platform: "darwin",
    run: async (/** @type {string} */ f) => (f === "python3" ? "Python 3.9.6" : f === "python3.13" ? "Python 3.13.16" : f === "git" ? "git version 2.50" : null) });
  assert.equal(mac.code, 0);
  assert.match(mac.steps[0], /export QQ_PYTHON=python3\.13/);
  assert.ok(mac.envs.every((e) => e.QQ_PYTHON === "python3.13"));
});

test("main: --remove --yes keeps local work and the guide's demo folders; asking deletes them only on a yes", async () => {
  const home = fakeHome();
  for (const d of DEMO) mkdirSync(join(home, d, "innernet"), { recursive: true });
  writeFileSync(join(home, ".zshrc"), `export QQ_PYTHON=python3.13\nexport PATH="$HOME/qq-tools/bin:$PATH"\n${XO_PATH_LINE}\n`);
  const yes = await drive(["--remove", "--yes", "--only", "qq"], { home, tty: false });
  assert.equal(yes.code, 0);
  assert.deepEqual(yes.steps, [QQ_REMOVE_TOOLS, cleanTmp(QQ_REMOVE[1])]);
  assert.ok(yes.out.includes("  kept ~/qq-try") && yes.out.includes("  kept ~/qq-ci-venv"));
  assert.ok(yes.out.includes("~/.zshrc still sets QQ_PYTHON; delete that line unless something else uses that Python."));
  // Asked: Enter keeps each demo folder; "y" deletes only that one.
  const asked = await drive(["--only", "qq"], { home, answers: ["r", "y", "", "y"] });
  assert.deepEqual(asked.steps, [QQ_REMOVE_TOOLS, "rm -rf ~/qq-try", cleanTmp(QQ_REMOVE[1])]);
  // Local work: --remove and --update keep qq, and say why.
  const work = await drive(["--remove", "--yes", "--only", "qq"], { home, tty: false, run: fakeRun({ ahead: "2" }) });
  assert.deepEqual(work.steps, []);
  assert.ok(work.out.some((l) => /has 2 local commits; updating or removing qq deletes them/.test(l)));
});

test("main: a broken xo is offered a reinstall, and --remove removes it", async () => {
  const home = fakeHome();
  const r = await drive(["--only", "xo"], { home, answers: ["", "y"], run: fakeRun({ xoRuns: false }) });
  assert.match(r.asked[0], /xo is there but not working\. Reinstall, delete or keep it\? \[R\/d\/k\]/);
  assert.deepEqual(r.steps, [XO.install.cmd, XO.path.cmd]);
  const rm = await drive(["--only", "xo", "--remove", "--yes"], { home, tty: false, run: fakeRun({ xoRuns: false }) });
  assert.deepEqual(rm.steps, XO.remove.map((s) => s.cmd));
});

test("main: options and HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-opt-"));
  assert.equal((await drive(["--update", "--remove"], { home })).code, 2);
  assert.equal((await drive(["--only", "gh"], { home })).code, 2);
  assert.equal((await drive([], { home: "relative/home" })).code, 2, "a relative HOME would aim rm -rf at the current folder");
  assert.equal((await drive([], { home: "" })).code, 2);
  const noTty = await drive([], { home, tty: false });
  assert.equal(noTty.code, 1);
  assert.match(noTty.out.at(-1) ?? "", /no terminal to ask in/);
});

test("cli: install --dry-run on an empty home lists the steps and runs nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-dry-"));
  const bin = new URL("../cli/bin.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [bin, "install", "--dry-run", "--only", "xo"], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, SHELL: "/bin/zsh" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /xo {2}not installed/);
  assert.ok(r.stdout.includes(XO.install.cmd) && r.stdout.includes(XO.path.cmd));
  assert.ok(!r.stdout.includes(INSTALL[0].cmd), "--only xo leaves qq alone");
  assert.match(r.stdout, /Dry run: nothing was run\./);
});
