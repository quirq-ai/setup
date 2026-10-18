// @ts-check
// The "This machine" panel's runner (cli/machine.mjs): only choices the state offers are planned, a run
// takes only the latest plan's id, once, and it refuses when the machine changed after the plan.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanTmp, QQ_REMOVE, QQ_REMOVE_TOOLS, removeLineCmd, SYNC_PIN, XO, XO_PIN } from "../cli/install.mjs";
import { checkChoice, machine, pipedStep } from "../cli/machine.mjs";

/** qq and xo installed, both on PATH, as their installs leave them. */
function home() {
  const h = mkdtempSync(join(tmpdir(), "qq-setup-machine-"));
  for (const d of ["qq-tools/depot/bin", "qq-tools/qqsync/bin", "qq-tools/bin", ".xo/bin"]) mkdirSync(join(h, d), { recursive: true });
  for (const f of ["qq-tools/depot/bin/qq", "qq-tools/qqsync/bin/pip", "qq-tools/bin/qq", ".xo/bin/xo", ".xo/bin/pip", ".xo/pyvenv.cfg"]) writeFileSync(join(h, f), "");
  writeFileSync(join(h, ".zshrc"), 'export QQ_PYTHON=python3.13\nexport PATH="$HOME/qq-tools/bin:$PATH"\nexport PATH="$HOME/.xo/bin:$PATH"\n');
  return h;
}

/** @param {{ ahead?: string }} [o] @returns {any} */
function fakeRun(o = {}) {
  return async (/** @type {string} */ file, /** @type {string[]} */ args) => {
    if (file === "git") {
      return args.includes("rev-parse") ? `${"a".repeat(40)}\n` : args.includes("rev-list") ? `${o.ahead ?? "0"}\n`
        : args.includes("status") || args.includes("stash") ? "" : args.includes("worktree") ? `worktree ${args[1]}\n\n` : "git version 2.50";
    }
    if (file.endsWith("/xo")) return "xo 0.1.0\n";
    if (file.includes("qqsync")) return `qqsync @ git+https://github.com/quirq-ai/sync@${SYNC_PIN}\n`;
    if (file.endsWith("/pip")) return `quirq-xo @ git+https://github.com/quirq-ai/xo@${XO_PIN}\n`;
    return file === "python3" ? "Python 3.13.16" : null;
  };
}

/** A machine whose steps are recorded, not run; `codes` are their exit codes in order. */
function setup(/** @type {{ h?: string, codes?: number[], run?: any }} */ o = {}) {
  const h = o.h ?? home();
  /** @type {string[]} */
  const ran = [];
  const codes = o.codes ?? [];
  let run = o.run ?? fakeRun();
  const m = machine({
    home: h, env: { HOME: h, PATH: "/usr/bin" }, platform: "linux", latest: "a".repeat(40),
    run: (/** @type {string} */ f, /** @type {string[]} */ a, /** @type {any} */ e) => run(f, a, e),
    runStep: async (cmd, _env, out) => (ran.push(cmd), out(`\x1b[32mran\x1b[0m ${ran.length}\n`), codes.shift() ?? 0),
  });
  return { m, h, ran, setRun: (/** @type {any} */ r) => (run = r) };
}

async function finished(/** @type {ReturnType<typeof machine>} */ m) {
  for (let i = 0; i < 100 && m.busy(); i++) await new Promise((ok) => setTimeout(ok, 5));
  return m.progress(0);
}

test("checkChoice: only offered actions, known fields, and extras only with qq's remove", async () => {
  const { m } = setup();
  const s = await m.state();
  assert.deepEqual(s.qq.choices, ["keep", "update", "remove"]);
  assert.deepEqual(s.qq.pythonLine, { line: "export QQ_PYTHON=python3.13", files: [".zshrc"] });
  const state = /** @type {any} */ ({ qq: { ...s.qq, behind: [] }, xo: { ...s.xo, behind: [] } });
  assert.equal(checkChoice({ qq: "keep", cmd: "rm -rf ~" }, state, []).ok, false);
  assert.equal(checkChoice({ qq: "path" }, state, []).ok, false, "path is offered only when only the PATH line is missing");
  assert.equal(checkChoice({ qq: "nuke" }, state, []).ok, false);
  assert.equal(checkChoice({ qq: "keep", demo: ["qq-try"] }, state, ["qq-try"]).ok, false, "demo folders only with remove");
  assert.equal(checkChoice({ qq: "remove", demo: ["qq-try"] }, state, []).ok, false, "only folders that are there");
  assert.equal(checkChoice({ qq: "remove", demo: ["qq-try", "qq-try"] }, state, ["qq-try"]).ok, false);
  assert.equal(checkChoice({ qq: "remove", demo: ["../etc"] }, state, ["qq-try"]).ok, false);
  assert.equal(checkChoice({ qq: "keep", python: true }, state, []).ok, false, "the QQ_PYTHON line only with remove");
  assert.equal(checkChoice({ qq: "remove", python: "yes" }, state, []).ok, false);
  assert.equal(checkChoice([], state, []).ok, false);
  assert.deepEqual(checkChoice({}, state, []), { ok: true, choice: { qq: "keep", xo: "keep", demo: [], python: false } });
  // A ~/.xo that is not xo's offers nothing but keep.
  const foreign = /** @type {any} */ ({ ...state, xo: { ...state.xo, foreign: true } });
  assert.equal(checkChoice({ xo: "remove" }, foreign, []).ok, false);
});

test("plan then run: the planned steps run once, in order, with their output for the page", async () => {
  const { m, ran } = setup();
  const p = /** @type {any} */ (await m.plan({ qq: "remove", xo: "keep", python: true }));
  assert.equal(p.ok, true);
  const want = [QQ_REMOVE_TOOLS, cleanTmp(QQ_REMOVE[1]), cleanTmp(removeLineCmd("export QQ_PYTHON=python3.13", "QQ_PYTHON"))];
  assert.deepEqual(p.steps.map((/** @type {any} */ s) => s.cmd), want);
  // Only { id } starts it.
  assert.equal((await m.start({ id: p.id, cmd: "x" })).ok, false);
  assert.equal((await m.start({ id: "other" })).ok, false);
  const r = await m.start({ id: p.id });
  assert.equal(r.ok, true);
  const done = /** @type {any} */ (await finished(m));
  assert.deepEqual(ran, want);
  assert.equal(done.run.code, 0);
  assert.deepEqual(done.run.steps.map((/** @type {any} */ s) => s.status), ["ok", "ok", "ok"]);
  assert.ok(!done.run.log.includes("\x1b"), "colour codes are stripped");
  assert.match(done.run.log, /\[1\/3\] Remove qq/);
  // Offsets: from `next` there is nothing new.
  assert.equal(/** @type {any} */ (m.progress(done.run.next)).run.log, "");
  // One run per plan.
  assert.equal((await m.start({ id: p.id })).ok, false);
  assert.equal(ran.length, 3);
});

test("a run is refused when the machine changed after the plan, such as new local work", async () => {
  const { m, ran, setRun } = setup();
  const p = /** @type {any} */ (await m.plan({ qq: "update" }));
  assert.ok(p.id);
  setRun(fakeRun({ ahead: "2" }));
  const r = /** @type {any} */ (await m.start({ id: p.id }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /something changed on this machine/);
  assert.deepEqual(ran, []);
});

test("a failed step stops the rest", async () => {
  const { m, ran } = setup({ codes: [0, 5] });
  const p = /** @type {any} */ (await m.plan({ qq: "remove", xo: "remove" }));
  await m.start({ id: p.id });
  const done = /** @type {any} */ (await finished(m));
  assert.equal(ran.length, 2);
  assert.equal(done.run.code, 2);
  assert.deepEqual(done.run.steps.map((/** @type {any} */ s) => s.status), ["ok", "failed", ...XO.remove.map(() => "pending")]);
  assert.match(done.run.log, /step 2 exited 5; the steps after it did not run/);
});

test("pipedStep: no input, output piped, exit code returned", async () => {
  let out = "";
  assert.equal(await pipedStep("read x || echo no-input; echo err >&2; exit 3", { PATH: "/usr/bin:/bin" }, (s) => (out += s)), 3);
  assert.match(out, /no-input/);
  assert.match(out, /err/);
});
