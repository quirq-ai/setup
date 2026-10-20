// @ts-check
// The form's "This machine" panel: the same install, update and remove as `qq-setup install`
// (cli/install.mjs), chosen on the page and run here. The page never sends a command. It sends a
// choice per tool, which must be one the tool's state offers (choices()), with the signature of the
// look it is showing. The server turns it into steps with planSteps and keeps that plan. A run takes
// only the id of the latest plan. Planning refuses when the machine no longer matches what the page
// shows, and running refuses when it no longer matches the plan or the steps differ, so the
// guarantees the page showed (local work kept, nothing removed unless chosen) still hold.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { windowsNote } from "./windows.mjs";
import { afterNotes, choices, DEMO, describe, detect, prepare, read, stepCommand, XO_PIN } from "./install.mjs";

/** @typedef {import("./install.mjs").Action} Action */
/** @typedef {import("./install.mjs").State} State */
/** @typedef {{ qq: Action, xo: Action, demo: string[], python: boolean }} Choice */

/** The longest log the page is sent; later output still reaches the terminal. */
const MAX_LOG = 256 * 1024;
// Colour and cursor codes from a step's output: the page shows text only.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;

/**
 * @typedef {{ status: "pending" | "running" | "ok" | "failed", code?: number }} StepState
 * @typedef {{ id: string, steps: { what: string, cmd: string }[], status: StepState[],
 *   log: string, truncated: boolean, done: boolean, code: number | null, notes: string[] }} Run
 */

/**
 * @param {{ home: string, env: NodeJS.ProcessEnv, platform: string, run?: import("./install.mjs").Read,
 *   runStep?: (cmd: string, env: NodeJS.ProcessEnv, onOutput: (s: string) => void) => Promise<number>,
 *   echo?: (s: string) => void, latest?: string | null }} o
 *   echo: where a step's output also goes (the terminal)
 */
export function machine({ home, env, platform, run = read, runStep: step = pipedStep, echo = () => {}, latest }) {
  /** @type {{ id: string, choice: Choice, cmds: string[], seen: string } | null} */
  let plan = null;
  /** @type {Run | null} */
  let current = null;
  // Set from a run's first check to its first step, so nothing else plans or starts in between.
  let starting = false;
  // Each plan request's number: only the newest one started is kept (choices can overlap).
  let planSeq = 0;
  const busy = () => starting || (!!current && !current.done);

  const look = () => detect({ home, latest, run, platform });
  const demoHere = () => DEMO.filter((d) => existsSync(join(home, d)));
  // What the page was shown: a run starts only while the machine still looks the same (local work included).
  const seen = (/** @type {State} */ s) => JSON.stringify([describe(s), s.qq.localWork, s.qq.pythonLine, demoHere()]);

  /** @param {State} state @param {Choice} choice */
  const stepsFor = (state, choice) =>
    prepare({ qq: choice.qq, xo: choice.xo }, state, { demo: choice.demo, pythonLine: choice.python, env, platform, run });

  return {
    /** What the panel shows: each tool's line, its choices (the default first) and what to warn about. */
    async state() {
      const s = await look();
      const [qqLine, xoLine] = describe(s).map((l) => l.replace(/^ {2}(qq|xo) {2}/, ""));
      return {
        platform,
        pin: XO_PIN,
        running: busy(),
        seen: seen(s),
        demo: demoHere(),
        qq: { line: qqLine, choices: choices(s.qq), installed: s.qq.installed, broken: s.qq.broken, localWork: s.qq.localWork,
          pythonLine: s.qq.pythonLine, note: s.qq.unsupported ? windowsNote(env, process.cwd()) : null },
        xo: { line: xoLine, choices: choices(s.xo), installed: s.xo.installed, broken: s.xo.broken, foreign: s.xo.foreign, note: s.xo.note },
      };
    },

    /** Check a choice and turn it into steps; the plan kept is the one a run may start. @param {unknown} body */
    async plan(body) {
      if (busy()) return { ok: false, status: 409, error: "a run is going: wait for it to finish" };
      const n = ++planSeq;
      // The look the page is showing, which its warnings came from; the rest is the choice.
      const { seen: shown, ...rest } = body && typeof body === "object" && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : { seen: null };
      const s = await look();
      if (n !== planSeq) return { ok: false, status: 409, superseded: true, error: "a newer choice replaced this one" };
      if (busy()) return { ok: false, status: 409, error: "a run is going: wait for it to finish" };
      if (typeof shown !== "string" || shown !== seen(s)) {
        plan = null;
        return { ok: false, status: 409, changed: true, error: "this machine changed since the page looked at it: here is what is there now" };
      }
      const c = checkChoice(rest, s, demoHere());
      if (!c.ok) return c;
      const p = await stepsFor(s, c.choice);
      if (n !== planSeq) return { ok: false, status: 409, superseded: true, error: "a newer choice replaced this one" };
      if (busy()) return { ok: false, status: 409, error: "a run is going: wait for it to finish" };
      if (p.stop) {
        plan = null;
        return { ok: /** @type {const} */ (true), id: null, steps: [], stop: p.stop, notes: [] };
      }
      plan = { id: randomBytes(16).toString("base64url"), choice: c.choice, cmds: p.steps.map((x) => x.cmd), seen: seen(s) };
      return { ok: /** @type {const} */ (true), id: plan.id, steps: p.steps, stop: null, notes: planNotes(c.choice) };
    },

    /** Run the latest plan, by its id, once. @param {unknown} body */
    async start(body) {
      if (busy()) return { ok: false, status: 409, error: "a run is already going" };
      const id = body && typeof body === "object" && "id" in body ? body.id : null;
      if (!plan || typeof id !== "string" || id !== plan.id || Object.keys(/** @type {object} */ (body)).length !== 1) {
        return { ok: false, status: 409, error: "that is not the latest plan: review the plan again" };
      }
      const kept = plan;
      plan = null; // one run per plan
      starting = true;
      try {
        return await begin(kept);
      } finally {
        starting = false;
      }
    },

    /** The run's progress, with the log from character `from`. @param {number} from */
    progress(from) {
      const r = current;
      if (!r) return { running: false, run: null };
      const at = Number.isInteger(from) && from >= 0 && from <= r.log.length ? from : 0;
      return { running: !r.done, run: { id: r.id, steps: r.steps.map((s, i) => ({ what: s.what, ...r.status[i] })),
        log: r.log.slice(at), next: r.log.length, done: r.done, code: r.code, notes: r.notes } };
    },

    /** True while a run is starting or going: the form must not stop under it, and nothing else plans or runs. */
    busy,
  };

  /** Look again, then run the kept plan's steps in the background. @param {NonNullable<typeof plan>} kept */
  async function begin(kept) {
    // Look again: the same choice must still give the same steps.
    const s = await look();
    const c = checkChoice(kept.choice, s, demoHere());
    const p = c.ok ? await stepsFor(s, c.choice) : null;
    if (!c.ok || !p || p.stop || seen(s) !== kept.seen || p.steps.map((x) => x.cmd).join("\n") !== kept.cmds.join("\n")) {
      return { ok: false, status: 409, error: "something changed on this machine since the plan was made: review the plan again" };
    }
    if (!p.steps.length) return { ok: false, status: 409, error: "nothing to run" };
    /** @type {Run} */
    const r = { id: kept.id, steps: p.steps, status: p.steps.map(() => ({ status: "pending" })), log: "", truncated: false,
      done: false, code: null, notes: [] };
    current = r;
    echo("\nRunning the steps picked in the form:\n");
    const add = (/** @type {string} */ text) => {
      echo(text);
      if (r.truncated) return;
      const clean = text.replace(ANSI, "");
      if (r.log.length + clean.length > MAX_LOG) {
        r.log += clean.slice(0, MAX_LOG - r.log.length);
        r.log += "\n[output cut here; the rest is in the terminal]\n";
        r.truncated = true;
      } else r.log += clean;
    };
    void (async () => {
      try {
        for (const [i, st] of r.steps.entries()) {
          r.status[i] = { status: "running" };
          add(`\n[${i + 1}/${r.steps.length}] ${st.what}\n$ ${st.cmd}\n`);
          const code = await step(st.cmd, p.env, add);
          r.status[i] = { status: code === 0 ? "ok" : "failed", code };
          if (code !== 0) {
            add(`\nstep ${i + 1} exited ${code}; the steps after it did not run. Fix it, then run it again (every step is safe to run again).\n`);
            r.code = 2;
            return;
          }
        }
        r.code = 0;
        r.notes = afterNotes({ qq: kept.choice.qq, xo: kept.choice.xo }, home);
        if (kept.choice.xo === "install") r.notes.push("Open a new terminal, then log xo in:  xo login  (it opens your browser to sign in to XO; xo login --key asks for your XO API key instead)");
      } catch (e) {
        add(`\n${e instanceof Error ? e.message : String(e)}\n`);
        r.code = 2;
      } finally {
        r.done = true;
      }
    })();
    return { ok: /** @type {const} */ (true), id: r.id };
  }
}

/**
 * Accept only `{ qq, xo, demo, python }`, each action one this tool's state offers, and demo folders
 * and the QQ_PYTHON line only with qq's remove and only when they are there.
 * @param {unknown} body @param {State} s @param {string[]} demoHere
 * @returns {{ ok: true, choice: Choice } | { ok: false, error: string }}
 */
export function checkChoice(body, s, demoHere) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "expected an object" };
  const b = /** @type {Record<string, unknown>} */ (body);
  for (const k of Object.keys(b)) if (!["qq", "xo", "demo", "python"].includes(k)) return { ok: false, error: `unexpected field: ${k}` };
  /** @type {Choice} */
  const choice = { qq: "keep", xo: "keep", demo: [], python: false };
  for (const tool of /** @type {const} */ (["qq", "xo"])) {
    const a = b[tool] ?? "keep";
    const offered = choices(s[tool]);
    if (typeof a !== "string" || !(a === "keep" || offered.includes(/** @type {Action} */ (a)))) {
      return { ok: false, error: `${tool}: ${JSON.stringify(a)} is not one of ${["keep", ...offered.filter((x) => x !== "keep")].join(", ")}` };
    }
    choice[tool] = /** @type {Action} */ (a);
  }
  const demo = b.demo ?? [];
  if (!Array.isArray(demo) || !demo.every((d) => typeof d === "string" && demoHere.includes(d)) || new Set(demo).size !== demo.length) {
    return { ok: false, error: `demo: only folders that are there: ${demoHere.join(", ") || "none"}` };
  }
  if (demo.length && choice.qq !== "remove") return { ok: false, error: "demo folders are deleted only with qq's remove" };
  choice.demo = /** @type {string[]} */ (demo);
  const python = b.python ?? false;
  if (typeof python !== "boolean") return { ok: false, error: "python: true or false" };
  if (python && (choice.qq !== "remove" || !s.qq.pythonLine)) return { ok: false, error: "the QQ_PYTHON line is deleted only with qq's remove, and only when it is there" };
  choice.python = python;
  return { ok: true, choice };
}

/** What the page should say under the plan. @param {Choice} c */
function planNotes(c) {
  /** @type {string[]} */
  const notes = [];
  if (c.xo === "remove") {
    notes.push("Run from this page, xo logout keeps your gh login (it asks only in a terminal). To log gh out too, run  gh auth logout");
  }
  return notes;
}

/**
 * Run one step in sh (cmd.exe on Windows) with no input, its output piped to onOutput; resolves to its exit code.
 * @param {string} cmd @param {NodeJS.ProcessEnv} env @param {(s: string) => void} onOutput
 * @returns {Promise<number>}
 */
export function pipedStep(cmd, env, onOutput) {
  return new Promise((ok) => {
    const [file, args, opts] = stepCommand(cmd);
    const child = spawn(file, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (c) => onOutput(String(c)));
    child.stderr.on("data", (c) => onOutput(String(c)));
    child.on("error", () => ok(127));
    child.on("close", (code, signal) => ok(code ?? (signal ? 128 : 1)));
  });
}

