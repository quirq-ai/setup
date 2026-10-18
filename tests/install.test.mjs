// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultAction, describe, detect, pickPython, pinIn, planSteps, pythonOk, QQ_REMOVE, removeLineCmd, SYNC_PIN, XO,
  XO_PATH_LINE, XO_PIN, XO_SPEC,
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

test("qq's remove commands are the qq guide's, byte for byte, at the commit install.mjs names", () => {
  const { cmds, sha } = fixture("qq-guide-remove.txt");
  assert.deepEqual(QQ_REMOVE, cmds);
  assert.ok(source.includes(`install.mdx, at ${sha.slice(0, 7)})`), `cli/install.mjs must name docs commit ${sha.slice(0, 7)}`);
  // The same template removes xo's line, so it is the guide's command with only the line changed.
  assert.equal(removeLineCmd('export PATH="$HOME/qq-tools/bin:$PATH"', "qq-tools/bin"), QQ_REMOVE[1]);
  assert.ok(XO.remove[2].cmd.includes(`grep -qsxF '${XO_PATH_LINE}'`));
});

test("xo's commands follow the xo quickstart at the commit install.mjs names", () => {
  const { cmds: [pipLine, update, logout, rm], sha } = fixture("xo-quickstart.txt");
  assert.ok(source.includes(`quickstart.md:18, at ${sha.slice(0, 7)})`), `cli/install.mjs must name xo commit ${sha.slice(0, 7)}`);
  assert.ok(pipLine.includes(`"${XO_SPEC}"`), "the pin is the quickstart's");
  assert.ok(XO.install.cmd.includes(`"${XO_SPEC}"`));
  assert.equal(XO.update.cmd, update.replace("NEW_SHA", XO_PIN));
  assert.equal(XO.remove[0].cmd, `~/.xo/bin/${logout}`); // by path: xo may not be on PATH in this shell
  assert.equal(XO.remove[1].cmd, rm);
  assert.match(XO_PIN, /^[0-9a-f]{40}$/);
  assert.equal(SYNC_PIN, /sync@([0-9a-f]{40})/.exec(INSTALL[1].cmd)?.[1]);
});

test("zsh-safe: no comment or history characters in anything install runs", () => {
  const all = [...QQ_REMOVE, XO.install.cmd, XO.path.cmd, XO.update.cmd, ...XO.remove.map((s) => s.cmd)];
  for (const c of all) assert.doesNotMatch(c, /[#!]/, c);
});

test("pinIn and pythonOk", () => {
  const freeze = `pip==25.0\nquirq-xo @ git+https://github.com/quirq-ai/xo@${XO_PIN}\n`;
  assert.equal(pinIn(freeze, "quirq-xo"), XO_PIN);
  assert.equal(pinIn(freeze, "qqsync"), null);
  assert.equal(pinIn(null, "qqsync"), null);
  assert.equal(pinIn(`quirq-xo @ git+https://evil.example/quirq-ai/xo@${XO_PIN}`, "quirq-xo"), null);
  assert.ok(pythonOk("Python 3.11.4") && pythonOk("Python 3.13.16") && pythonOk("Python 4.0.0"));
  assert.ok(!pythonOk("Python 3.11.3") && !pythonOk("Python 3.9.6") && !pythonOk(null));
});

test("pickPython: QQ_PYTHON, else python3, else the newest python3.N, which qq must be told about", async () => {
  /** @param {Record<string, string>} have @returns {any} */
  const run = (have) => async (/** @type {string} */ cmd) => have[cmd] ?? null;
  assert.deepEqual(await pickPython({ QQ_PYTHON: "python3.12" }, run({ "python3.12": "Python 3.12.1" })),
    { cmd: "python3.12", version: "Python 3.12.1", ok: true, persist: false });
  assert.deepEqual(await pickPython({}, run({ python3: "Python 3.13.16" })), { cmd: "python3", version: "Python 3.13.16", ok: true, persist: false });
  // A stock Mac: python3 is 3.9 and brew added python3.13.
  assert.deepEqual(await pickPython({}, run({ python3: "Python 3.9.6", "python3.13": "Python 3.13.16" })),
    { cmd: "python3.13", version: "Python 3.13.16", ok: true, persist: true });
  assert.deepEqual(await pickPython({}, run({ python3: "Python 3.9.6" })), { cmd: null, version: "Python 3.9.6", ok: false, persist: false });
});

const none = { qq: { installed: false, commit: null, latest: null, syncPin: null, onPath: false, behind: [] },
  xo: { installed: false, pin: null, onPath: false, behind: [] } };
const py = { cmd: "python3", version: "Python 3.13.16", ok: true, persist: false };

test("planSteps: install, update and remove, in order", () => {
  const all = planSteps({ qq: "install", xo: "install" }, none, py, "linux");
  assert.deepEqual(all.steps, [...INSTALL, XO.install, XO.path]);
  const here = { qq: { ...none.qq, installed: true }, xo: { ...none.xo, installed: true, onPath: true } };
  assert.deepEqual(planSteps({ qq: "keep", xo: "update" }, here, py, "linux").steps, [XO.update]);
  assert.deepEqual(planSteps({ qq: "update", xo: "keep" }, here, py, "linux").steps, INSTALL);
  const gone = planSteps({ qq: "remove", xo: "remove" }, here, py, "linux").steps.map((s) => s.cmd);
  assert.deepEqual(gone, [...QQ_REMOVE, ...XO.remove.map((s) => s.cmd)]);
  assert.deepEqual(planSteps({ qq: "keep", xo: "keep" }, here, py, "linux").steps, []);
});

test("planSteps: Python comes first when an install needs it", () => {
  const old = { cmd: null, version: "Python 3.9.6", ok: false, persist: false };
  const mac = planSteps({ qq: "install", xo: "keep" }, none, old, "darwin").steps;
  assert.equal(mac[0], MAC_PYTHON);
  assert.match(planSteps({ qq: "install", xo: "keep" }, none, old, "linux").stop ?? "", /Python 3\.11\.4 or newer \(found Python 3\.9\.6\)/);
  // Removing needs no Python.
  assert.equal(planSteps({ qq: "remove", xo: "keep" }, { ...none, qq: { ...none.qq, installed: true } }, old, "linux").stop, null);
  const brewed = planSteps({ qq: "install", xo: "keep" }, none, { cmd: "python3.13", version: "Python 3.13.16", ok: true, persist: true }, "darwin").steps;
  assert.match(brewed[0].cmd, /grep -qs 'QQ_PYTHON=' "\$rc" \|\| printf '\\nexport QQ_PYTHON=python3\.13\\n'/);
  assert.deepEqual(brewed.slice(1), INSTALL);
  // xo alone keeps its Python inside its venv: no QQ_PYTHON line.
  assert.deepEqual(planSteps({ qq: "keep", xo: "install" }, none, { cmd: "python3.13", version: "x", ok: true, persist: true }, "darwin").steps,
    [XO.install, XO.path]);
});

test("defaultAction: install what is missing, update what is behind, keep the rest", () => {
  assert.equal(defaultAction({ installed: false, behind: [] }, {}), "install");
  assert.equal(defaultAction({ installed: true, behind: ["x"] }, {}), "update");
  assert.equal(defaultAction({ installed: true, behind: [] }, {}), "keep");
  assert.equal(defaultAction({ installed: true, behind: [] }, { update: true }), "update");
  assert.equal(defaultAction({ installed: true, behind: [] }, { remove: true }), "remove");
  assert.equal(defaultAction({ installed: false, behind: [] }, { remove: true }), "keep");
});

test("detect reads what a previous install left", async () => {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-home-"));
  for (const d of ["qq-tools/depot/bin", "qq-tools/qqsync/bin", "qq-tools/bin", ".xo/bin"]) mkdirSync(join(home, d), { recursive: true });
  for (const f of ["qq-tools/depot/bin/qq", "qq-tools/qqsync/bin/pip", "qq-tools/bin/qq", ".xo/bin/xo", ".xo/bin/pip"]) writeFileSync(join(home, f), "");
  writeFileSync(join(home, ".zshrc"), `\nexport PATH="$HOME/qq-tools/bin:$PATH"\n`);
  const old = "1".repeat(40);
  /** @type {any} */
  const run = async (/** @type {string} */ file, /** @type {string[]} */ args) =>
    file === "git" ? "a".repeat(40) + "\n"
      : file.includes("qqsync") ? `qqsync @ git+https://github.com/quirq-ai/sync@${SYNC_PIN}\n`
        : `quirq-xo @ git+https://github.com/quirq-ai/xo@${old}\n${args.join(" ")}`;
  const s = await detect({ home, latest: "b".repeat(40), run });
  assert.deepEqual(s.qq, { installed: true, commit: "a".repeat(40), latest: "b".repeat(40), syncPin: SYNC_PIN, onPath: true,
    behind: ["qq aaaaaaa is behind bbbbbbb"] });
  assert.deepEqual(s.xo, { installed: true, pin: old, onPath: false, behind: [`xo is at 1111111, not ${XO_PIN.slice(0, 7)}`, "not on PATH"] });
  const lines = describe(s);
  assert.match(lines[0], /qq {2}installed at aaaaaaa, newest is bbbbbbb; qqsync at .{7}; on PATH: update available/);
  assert.match(lines[1], /xo {2}installed at 1111111; not on PATH: update available/);
  assert.deepEqual(describe(await detect({ home: mkdtempSync(join(tmpdir(), "qq-setup-empty-")), run })),
    ["  qq  not installed", "  xo  not installed"]);
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
  // No terminal and no --yes: it asks for one and stops.
  const noTty = spawnSync(process.execPath, [bin, "install"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home }, input: "" });
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /no terminal to ask in/);
  assert.equal(spawnSync(process.execPath, [bin, "install", "--update", "--remove"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } }).status, 2);
  assert.equal(spawnSync(process.execPath, [bin, "install", "--only", "gh"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } }).status, 2);
});
