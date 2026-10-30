// @ts-check
// Step 3's writes: add a product repo to qq, change a gated repo's merge rules, or take a repo out of
// qq, as pull requests in quirq-ai that the person reviews and merges. Nothing here merges, applies
// a ruleset, deletes one, or touches main.
//
// How a change is made: fresh anonymous clones of gate, infra-config and the repo (no credentials
// reach git), the files changed there by the tools that own them (infra-config's qqcfg, gate's
// `settings plan` for the golden file, cli/policy-edit.mjs for gate's settings and pin), all run in
// a child with an empty HOME and no token in its environment. The diff is shown on the page; only
// when the person presses Open does `ghWrite` turn it into a branch and a pull request through
// their own gh login, after checking that the base branch has not moved since the plan.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { encodeRef, GhError, isName } from "./gh.mjs";
import { addProduct, checkFields, editRepo, EditError, otherUses, removeRepo, repin } from "./policy-edit.mjs";
import { POLICY_ORG } from "./policies.mjs";
import { parseToml } from "./toml.mjs";

export class WriteError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "WriteError";
  }
}

/** Where the clones come from. QQ_SETUP_GIT_BASE points the tests at local repos. */
export const gitBase = (env = process.env) => env.QQ_SETUP_GIT_BASE || `https://github.com/${POLICY_ORG}`;

// What a child (git, Python) keeps from this process's environment: what finding programs, the
// network and the locale need. No token, no gh or git config, no SSH agent; HOME is an empty folder.
const CHILD_VARS = ["PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "HTTP_PROXY", "HTTPS_PROXY",
  "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "PIP_CERT",
  "REQUESTS_CA_BUNDLE"];

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(home, env = process.env) {
  /** @type {Record<string, string | undefined>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) if (CHILD_VARS.includes(k) || k.startsWith("LC_")) out[k] = v;
  return { ...out, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig"), PYTHONNOUSERSITE: "1", PIP_NO_INPUT: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1" };
}

/**
 * @typedef {{ cwd?: string, timeoutMs?: number }} RunOpts
 * @typedef {(cmd: string, args: string[], opts?: RunOpts) => Promise<string>} Run
 */

/**
 * Run a program (never a shell) with the child environment. Rejects with its last stderr line.
 * @param {string} home
 * @returns {Run}
 */
function runner(home) {
  return (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: /** @type {NodeJS.ProcessEnv} */ (childEnv(home)), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const lines = String(stderr).trim().split("\n").filter(Boolean);
        const tail = lines.slice(-3).join(" / ") || err.message;
        reject(new WriteError(`${basename(cmd)} failed: ${tail}`));
      });
  });
}

/**
 * @typedef {{
 *   key: "infra-config" | "repo" | "gate" | "apply" | "rulesets",
 *   repo: string,
 *   title: string,
 *   state: "done" | "open" | "ready" | "waiting" | "refused" | "manual",
 *   detail: string,
 *   url?: string,
 *   diff?: string,
 *   files?: string[],
 *   command?: string,
 *   notes?: string[],
 * }} Step
 * @typedef {{ path: string, mode: string, content: string | null }} Change  content null: delete
 * @typedef {{ step: Step, base: string, baseBranch: string, branch: string, changes: Change[], prTitle: string, prBody: string }} Ready
 * @typedef {{ op: "add" | "edit" | "remove", repo: string, fields: import("./policy-edit.mjs").RepoFields, kinds: string[],
 *   description: string }} Request
 */

/**
 * Check a request from the page.
 * @param {unknown} body
 * @returns {Request}
 */
export function checkRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new WriteError("expected a JSON object");
  const b = /** @type {Record<string, unknown>} */ (body);
  const extra = Object.keys(b).filter((k) => !["op", "repo", "fields", "kinds", "description"].includes(k));
  if (extra.length) throw new WriteError(`unknown field ${extra[0]}`);
  if (b.op !== "add" && b.op !== "edit" && b.op !== "remove") throw new WriteError("op must be add, edit or remove");
  if (typeof b.repo !== "string" || !isName(b.repo)) throw new WriteError("not a repo name");
  let fields;
  try {
    fields = checkFields(b.fields);
  } catch (e) {
    throw new WriteError(e instanceof Error ? e.message : String(e));
  }
  const kinds = b.kinds ?? [];
  if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== "string" || !isName(k)) || kinds.length > 8) {
    throw new WriteError("kinds must be a list of kind names");
  }
  const description = b.description ?? "";
  if (typeof description !== "string" || description.length > 200 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw new WriteError("the description must be one line of at most 200 characters");
  }
  if (b.op === "add") {
    if (!kinds.length) throw new WriteError("pick at least one kind");
    if (!description.trim()) throw new WriteError("a new repo needs a one-line description (infra-config lists it)");
    if (fields.approvals === undefined || fields.autoMerge === undefined) throw new WriteError("a new repo needs its approvals and auto-merge");
  } else if (kinds.length || description) throw new WriteError(`kinds and a description go with add, not ${b.op}`);
  if (b.op === "edit" && !Object.keys(fields).length) throw new WriteError("nothing to change");
  if (b.op === "remove" && Object.keys(fields).length) throw new WriteError("remove takes only the repo");
  return { op: b.op, repo: b.repo, fields, kinds: /** @type {string[]} */ (kinds), description };
}

/** How long a plan can be opened: after that the page plans again, from what is on GitHub then. */
const PLAN_MS = 30 * 60 * 1000;

/** The command an org admin runs once gate's pull request is merged (gate docs/apply-settings.md). @param {string} sha */
export const applyCommand = (sha) =>
  `( mkdir -p ~/qq-apply && cd ~/qq-apply && rm -rf qq-gate && git clone -q https://github.com/${POLICY_ORG}/gate qq-gate && cd ./qq-gate && git checkout -q ${sha} && scripts/apply.sh )`;

/**
 * @typedef {{
 *   getJson: (path: string) => Promise<any>,
 *   ghWrite: (path: string, body: Record<string, unknown>) => Promise<any>,
 *   python: string,
 *   base: string,
 *   now?: () => Date,
 * }} Deps
 */

/**
 * The writer for one run of the command: one scratch folder, one Python environment (made on the
 * first plan), the plans it made, and one job at a time.
 * @param {Deps} deps
 */
export function policyWriter(deps) {
  /** @type {string | null} */
  let root = null;
  /** @type {Promise<string> | null} */
  let venv = null;
  /** @type {Map<string, { at: number, ready: Map<string, Ready>, steps: Step[] }>} */
  const plans = new Map();
  let busy = false;
  let n = 0;

  /** @type {Promise<string> | null} */
  let made = null;
  /** The scratch folder, made once (two clones may ask at the same time). */
  function scratch() {
    made ??= (async () => {
      const dir = await mkdtemp(join(tmpdir(), "qq-setup-policies-"));
      root = dir;
      process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
      await mkdir(join(dir, "home"));
      await writeFile(join(dir, "home", "gitconfig"), "");
      return dir;
    })();
    return made;
  }

  /** @returns {Promise<Run>} */
  async function run() {
    return runner(join(await scratch(), "home"));
  }

  /**
   * A fresh shallow clone of one ref (a branch or a commit), from quirq-ai or from an earlier clone
   * (a folder), which saves fetching the same commit twice.
   * @param {string} repo @param {string} ref @param {string} [from]
   * @returns {Promise<{ dir: string, sha: string }>}
   */
  async function clone(repo, ref, from) {
    const r = await run();
    const dir = join(await scratch(), `${repo}-${++n}`);
    const git = (/** @type {string[]} */ ...a) => r("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
      "-C", dir, ...a], { timeoutMs: 180_000 });
    await mkdir(dir);
    await git("init", "-q");
    await git("fetch", "-q", "--depth", "1", "--no-tags", from ?? `${deps.base}/${repo}`, ref);
    await git("checkout", "-q", "FETCH_HEAD");
    return { dir, sha: (await git("rev-parse", "HEAD")).trim() };
  }

  /** gate's apply environment (hashed, wheels only), made once from gate's own requirements. @param {string} gateDir */
  function python(gateDir) {
    venv ??= (async () => {
      const r = await run();
      const dir = join(await scratch(), "venv");
      const ver = (await r(deps.python, ["-c", "import sys; print(sys.version_info >= (3, 11))"])).trim();
      if (ver !== "True") throw new WriteError(`${deps.python} is older than Python 3.11, which gate and infra-config need`);
      await r(deps.python, ["-m", "venv", dir]);
      const py = join(dir, "bin", "python");
      await r(py, ["-m", "pip", "install", "--quiet", "--require-hashes", "--only-binary", ":all:", "-r",
        join(gateDir, "apply-requirements.txt")], { timeoutMs: 600_000 });
      return py;
    })();
    venv.catch(() => (venv = null)); // a failed setup is tried again on the next plan
    return venv;
  }

  /**
   * Stage everything in a clone and read the change back from git's index: the diff to show, and
   * each file's new content and mode. Links and submodules are refused.
   * @param {string} dir
   * @returns {Promise<{ diff: string, changes: Change[] }>}
   */
  async function changes(dir) {
    const r = await run();
    const git = (/** @type {string[]} */ ...a) => r("git", ["-c", "core.quotePath=false", "-C", dir, ...a]);
    await git("add", "-A");
    const diff = await git("diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames");
    const names = (await git("diff", "--cached", "--name-status", "-z", "--no-renames")).split("\0").filter(Boolean);
    /** @type {Change[]} */
    const out = [];
    for (let i = 0; i < names.length; i += 2) {
      const [status, path] = [names[i], names[i + 1]];
      if (status === "D") {
        out.push({ path, mode: "100644", content: null });
        continue;
      }
      const mode = (await git("ls-files", "-s", "--", path)).split(" ")[0];
      if (mode !== "100644" && mode !== "100755") throw new WriteError(`${path}: a link or submodule; refusing to write it`);
      out.push({ path, mode, content: await git("show", `:${path}`) });
    }
    return { diff, changes: out };
  }

  /** Regenerate gate's golden plan against an infra-config checkout. @param {string} gateDir @param {string} icDir */
  async function golden(gateDir, icDir) {
    const r = await run();
    const py = await python(gateDir);
    const out = await r(py, ["-c", "import sys; sys.path.insert(0, 'src'); from qqgate.cli import main; sys.exit(main(sys.argv[1:]))",
      "settings", "plan", "--config", icDir], { cwd: gateDir, timeoutMs: 300_000 });
    await writeFile(join(gateDir, "tests", "golden", "quirq-settings-plan.json"), out);
  }

  /**
   * The newest open pull request from a branch qq-setup made for this op and repo
   * (`qq-setup/<op>-<repo>-<commit>`), so a re-run picks up where the last one stopped.
   * @param {string} repo  where to look @param {string} prefix  `qq-setup/<op>-<target>-`
   * @returns {Promise<string | null>} its link
   */
  async function openPr(repo, prefix) {
    const prs = await deps.getJson(`repos/${POLICY_ORG}/${repo}/pulls?state=open&per_page=100`);
    if (!Array.isArray(prs)) throw new WriteError(`unexpected answer listing ${repo}'s pull requests`);
    const mine = prs.filter((p) => typeof p?.head?.ref === "string" && p.head.ref.startsWith(prefix) &&
      /^[0-9a-f]{7}$/.test(p.head.ref.slice(prefix.length)) && p.head?.repo?.full_name === `${POLICY_ORG}/${repo}`);
    return mine.length ? String(mine[0].html_url) : null;
  }

  /**
   * One step that becomes a pull request: refused when the tools refuse, already open when a
   * pull request from this op is, done when there is nothing to change.
   * @param {{ key: Step["key"], repo: string, title: string, op: string, target: string, baseBranch: string,
   *   make: () => Promise<{ dir: string, sha: string, notes?: string[] }>, done: string, prTitle: string, prBody: string }} s
   * @param {Map<string, Ready>} ready
   * @returns {Promise<Step>}
   */
  async function prStep(s, ready) {
    const prefix = `qq-setup/${s.op}-${s.target}-`;
    const url = await openPr(s.repo, prefix);
    if (url) {
      return { key: s.key, repo: s.repo, title: s.title, state: "open", url,
        detail: `A qq-setup pull request to ${s.op} ${s.target} is open here: review and merge it, or close it on GitHub before planning a different change.` };
    }
    let made;
    try {
      made = await s.make();
    } catch (e) {
      if (e instanceof WriteError || e instanceof EditError) return { key: s.key, repo: s.repo, title: s.title, state: "refused", detail: e.message };
      throw e;
    }
    const { diff, changes: list } = await changes(made.dir);
    if (!list.length) return { key: s.key, repo: s.repo, title: s.title, state: "done", detail: s.done, notes: made.notes };
    const branch = `${prefix}${made.sha.slice(0, 7)}`;
    /** @type {Step} */
    const step = { key: s.key, repo: s.repo, title: s.title, state: "ready", diff, files: list.map((c) => c.path), notes: made.notes,
      detail: `Opens a pull request from ${branch} into ${s.baseBranch} of ${POLICY_ORG}/${s.repo}, through your gh login.` };
    ready.set(s.key, { step, base: made.sha, baseBranch: s.baseBranch, branch, changes: list, prTitle: s.prTitle, prBody: s.prBody });
    return step;
  }

  /**
   * @param {Request} req
   * @returns {Promise<{ steps: Step[], ready: Map<string, Ready> }>}
   */
  async function makePlan(req) {
    const { op, repo } = req;
    /** @type {Map<string, Ready>} */
    const ready = new Map();
    const [gate, ic] = await Promise.all([clone("gate", "main"), clone("infra-config", "main")]);
    const settingsPath = join(gate.dir, "settings", "github.toml");
    const settingsText = await readFile(settingsPath, "utf8");
    const settings = /** @type {any} */ (parseToml(settingsText));
    const gated = (settings.repo ?? []).find((/** @type {any} */ r) => r?.name === repo);
    const listed = ((/** @type {any} */ (parseToml(await readFile(join(ic.dir, "config", "repos.toml"), "utf8")))).repo ?? [])
      .some((/** @type {any} */ r) => r?.name === repo);
    const pins = /** @type {any} */ (parseToml(await readFile(join(gate.dir, "pins.toml"), "utf8")));
    const pinned = String(pins["infra-config"]?.commit ?? "");
    const short = (/** @type {string} */ s) => s.slice(0, 7);
    const by = "Opened with qq-setup (quirq-ai/setup) through the author's own gh login.";
    /** @type {Step[]} */
    const steps = [];

    /** gate's pull request for an add or remove: settings, the pin moved to infra-config main, the golden plan. */
    const gateAt = (/** @type {(t: string) => string} */ edit, /** @type {string} */ why) => async () => {
      const g = await clone("gate", gate.sha, gate.dir);
      const sp = join(g.dir, "settings", "github.toml");
      await writeFile(sp, edit(await readFile(sp, "utf8")));
      const pp = join(g.dir, "pins.toml");
      await writeFile(pp, repin(await readFile(pp, "utf8"), ic.sha, why));
      await golden(g.dir, ic.dir);
      return { dir: g.dir, sha: g.sha, notes: pinned === ic.sha ? [] : [`Moves gate's infra-config pin from ${short(pinned)} to ${short(ic.sha)} (infra-config main), which also brings in every other infra-config change merged in between; the golden plan shows what that changes.`] };
    };

    if (op === "edit") {
      if (!gated) throw new WriteError(`${repo} is not behind the gate: add it instead`);
      steps.push(await prStep({ key: "gate", repo: "gate", title: `gate: change ${repo}'s merge rules`, op, target: repo, baseBranch: "main",
        done: `gate's settings already have these values for ${repo}.`,
        prTitle: `${repo}: change merge rules (qq-setup)`,
        prBody: `Changes ${repo}'s \`[[repo]]\` in settings/github.toml and regenerates the golden plan against infra-config at the current pin (${short(pinned)}).\n\nOnce merged, an org admin applies it with gate's scripts/apply.sh (docs/apply-settings.md).\n\n${by}`,
        make: async () => {
          const g = await clone("gate", gate.sha, gate.dir);
          const icPin = pinned === ic.sha ? ic : await clone("infra-config", pinned);
          const sp = join(g.dir, "settings", "github.toml");
          await writeFile(sp, editRepo(await readFile(sp, "utf8"), repo, req.fields));
          await golden(g.dir, icPin.dir);
          return g;
        } }, ready));
      steps.push(applyStep(gate.sha, steps[0].state === "done"));
    } else if (op === "add") {
      if (gated && gated.kind !== "product") throw new WriteError(`${repo} is an infra repo in gate's settings; qq-setup adds product repos only`);
      const meta = await deps.getJson(`repos/${POLICY_ORG}/${repo}`).catch((e) => {
        if (e instanceof GhError && e.status === 404) throw new WriteError(`${POLICY_ORG}/${repo} is not there, or not visible to your gh login: create it (with a first commit, such as a README), then plan again`);
        throw e;
      });
      if (meta?.private) throw new WriteError(`${repo} is private: v0 adds public repos only (a merge queue on a private repo needs GitHub Enterprise Cloud)`);
      const defaultBranch = typeof meta?.default_branch === "string" ? meta.default_branch : "main";
      if (defaultBranch !== "main") throw new WriteError(`${repo}'s default branch is ${defaultBranch}: qq-setup adds repos whose default branch is main (what infra-config records and gate's rulesets protect)`);
      const kindArgs = req.kinds.flatMap((k) => ["--kind", k]);
      steps.push(listed
        ? { key: "infra-config", repo: "infra-config", title: `infra-config: list ${repo} and its pipelines`, state: "done", detail: `infra-config's repos.toml lists ${repo}.` }
        : await prStep({ key: "infra-config", repo: "infra-config", title: `infra-config: list ${repo} and its pipelines`, op, target: repo, baseBranch: "main",
          done: "", prTitle: `Add ${repo} as a product repo (qq-setup)`,
          prBody: `\`qqcfg add-repo ${repo} ${req.kinds.map((k) => `--kind ${k}`).join(" ")}\`: its \`[[repo]]\` in config/repos.toml, its presubmit and postsubmit builders in config/pipelines.toml, and what \`qqcfg generate\` writes from them. \`qqcfg validate\` passed.\n\nNext, once this merges: ${repo}'s workflows (\`qqcfg deliver\`) and gate's settings with a pin past this commit.\n\n${by}`,
          make: async () => {
            const c = await clone("infra-config", ic.sha, ic.dir);
            const py = await python(gate.dir);
            await (await run())(py, [join(c.dir, "tools", "qqcfg.py"), "add-repo", repo, ...kindArgs, `--description=${req.description}`, "--root", c.dir], { cwd: c.dir });
            return c;
          } }, ready));
      steps.push(!listed
        ? { key: "repo", repo, title: `${repo}: its qq workflows`, state: "waiting", detail: "Planned once infra-config's pull request is merged: the workflows come from infra-config main." }
        : await prStep({ key: "repo", repo, title: `${repo}: its qq workflows`, op, target: repo, baseBranch: defaultBranch,
          done: `${repo}'s qq workflows match infra-config main.`,
          prTitle: "Add qq's generated workflows (qq-setup)",
          prBody: `\`qqcfg deliver ${repo}\` from infra-config ${short(ic.sha)}: the generated qq-*.yml workflows for this repo's pipelines. Their checks run \`qq\`, which reads infra/repo.toml.\n\n${by}`,
          make: async () => {
            const t = await clone(repo, defaultBranch);
            const py = await python(gate.dir);
            await (await run())(py, [join(ic.dir, "tools", "qqcfg.py"), "deliver", repo, t.dir, "--root", ic.dir], { cwd: ic.dir });
            let manifest = true;
            try {
              await readFile(join(t.dir, "infra", "repo.toml"));
            } catch {
              manifest = false;
            }
            return { ...t, notes: manifest ? [] : [`${repo} has no infra/repo.toml, which qq reads; the checks fail until it does. In a clone of ${repo}: qqsync init . ${req.kinds.map((k) => `--kind ${k}`).join(" ")} --kinds <infra-config>/config/kinds.toml --promoted <toolchains>/promoted.toml --qq-version <qq version>, then add each target's srcs (sync README, "Start a new repo"). qq-setup prints this; it does not write the manifest.`] };
          } }, ready));
      steps.push(gated
        ? { key: "gate", repo: "gate", title: `gate: put ${repo} behind the gate`, state: "done", detail: `gate's settings list ${repo}.` }
        : !listed
          ? { key: "gate", repo: "gate", title: `gate: put ${repo} behind the gate`, state: "waiting", detail: "Planned once infra-config's pull request is merged: gate's pin must name an infra-config commit that lists the repo." }
          : await prStep({ key: "gate", repo: "gate", title: `gate: put ${repo} behind the gate`, op, target: repo, baseBranch: "main",
            done: "", prTitle: `Add ${repo} as a product repo (qq-setup)`,
            prBody: `One \`[[repo]]\` for ${repo} in settings/github.toml, pins.toml's infra-config pin moved to ${short(ic.sha)} (which lists it), and the golden plan regenerated (docs/apply-settings.md, "Adding a product repo").\n\nOnce merged, an org admin applies it with scripts/apply.sh; ${repo} gets its rulesets once it is ready (\`settings verify\`).\n\n${by}`,
            make: gateAt((t) => addProduct(t, repo, /** @type {any} */ (req.fields)), `${repo} added with qq-setup`) }, ready));
      steps.push(applyStep(gate.sha, !!gated));
    } else {
      if (gated && gated.kind !== "product") throw new WriteError(`${repo} is one of qq's own infra repos (infra-config org.toml); qq-setup takes product repos out only`);
      if (gated && otherUses(settings, repo).length) {
        throw new WriteError(`gate's settings also name ${repo} in ${otherUses(settings, repo).join(" and ")}; take it out there by hand in a reviewed gate pull request first`);
      }
      if (!gated && !listed) throw new WriteError(`${repo} is in neither gate's settings nor infra-config's repos.toml`);
      steps.push(!listed
        ? { key: "infra-config", repo: "infra-config", title: `infra-config: take ${repo} out`, state: "done", detail: `infra-config's repos.toml does not list ${repo}.` }
        : await prStep({ key: "infra-config", repo: "infra-config", title: `infra-config: take ${repo} out`, op, target: repo, baseBranch: "main",
          done: "", prTitle: `Take ${repo} out of qq (qq-setup)`,
          prBody: `\`qqcfg remove-repo ${repo}\`: its \`[[repo]]\` and builders, and what \`qqcfg generate\` writes from them. \`qqcfg validate\` passed. The repo itself, its code and its delivered qq-*.yml files are not touched.\n\n${by}`,
          make: async () => {
            const c = await clone("infra-config", ic.sha, ic.dir);
            const py = await python(gate.dir);
            await (await run())(py, [join(c.dir, "tools", "qqcfg.py"), "remove-repo", repo, "--root", c.dir], { cwd: c.dir });
            return c;
          } }, ready));
      steps.push(!gated
        ? { key: "gate", repo: "gate", title: `gate: take ${repo} out of the settings`, state: "done", detail: `gate's settings do not list ${repo}.` }
        : listed
          ? { key: "gate", repo: "gate", title: `gate: take ${repo} out of the settings`, state: "waiting", detail: "Planned once infra-config's pull request is merged: gate's settings and its infra-config pin must agree on the products." }
          : await prStep({ key: "gate", repo: "gate", title: `gate: take ${repo} out of the settings`, op, target: repo, baseBranch: "main",
            done: "", prTitle: `Take ${repo} out of qq (qq-setup)`,
            prBody: `Drops ${repo}'s \`[[repo]]\` from settings/github.toml, moves pins.toml's infra-config pin to ${short(ic.sha)} (which no longer lists it), and regenerates the golden plan (docs/apply-settings.md, "Taking a repo out of qq").\n\nApply then leaves ${repo} alone: its rulesets stay live until an admin deletes them.\n\n${by}`,
            make: gateAt((t) => removeRepo(t, repo), `${repo} removed with qq-setup`) }, ready));
      steps.push(await rulesetsStep(repo));
    }
    return { steps, ready };
  }

  /**
   * The apply command, once gate's change is on main: then gate main is the commit to apply.
   * @param {string} sha  gate main @param {boolean} merged  gate main already has the change
   */
  function applyStep(sha, merged) {
    return /** @type {Step} */ ({ key: "apply", repo: "gate", title: "Apply gate's settings on GitHub (an org admin)", state: merged ? "manual" : "waiting",
      detail: merged
        ? "gate main has the change. An org admin runs this (gate docs/apply-settings.md): it shows what it would change on GitHub and asks before writing. qq-setup never applies settings."
        : "Once gate's pull request is merged, plan again here for the command an org admin runs. qq-setup never applies settings.",
      command: merged ? applyCommand(sha) : undefined });
  }

  /** What stays on GitHub after a remove, with the commands that lift it. @param {string} repo */
  async function rulesetsStep(repo) {
    /** @type {string[]} */
    const lines = [];
    try {
      const rules = await deps.getJson(`repos/${POLICY_ORG}/${repo}/rulesets?per_page=100`);
      for (const r of Array.isArray(rules) ? rules : []) {
        if (typeof r?.name === "string" && r.name.startsWith("qq-") && Number.isInteger(r.id)) {
          lines.push(`gh api --method DELETE repos/${POLICY_ORG}/${repo}/rulesets/${r.id}   # ${r.name}`);
        }
      }
    } catch (e) {
      lines.push(`# could not list ${repo}'s rulesets (${e instanceof Error ? e.message : String(e)}): gh api repos/${POLICY_ORG}/${repo}/rulesets lists them`);
    }
    return /** @type {Step} */ ({ key: "rulesets", repo, title: `What stays on ${repo} afterwards`, state: "manual",
      detail: `Taking ${repo} out of qq does not lift what is already on GitHub. Its qq-main ruleset (and any other qq- ruleset) stays live and keeps gating its pull requests, and its qq-*.yml workflows stay in the repo and keep running, until someone removes them. qq-setup deletes nothing. To lift the rulesets, a repo admin deletes them in ${repo}'s Settings > Rules, or runs the lines below; delete the workflows in a pull request of the repo's own.`,
      command: lines.length ? lines.join("\n") : `# ${repo} has no qq- ruleset`,
    });
  }

  /**
   * Turn a ready step into a branch and a pull request. Refuses when the base branch moved since
   * the plan (plan again) or the branch is already there.
   * @param {Ready} r
   * @returns {Promise<string>} the pull request's link
   */
  async function open(r) {
    const repo = r.step.repo;
    const head = await deps.getJson(`repos/${POLICY_ORG}/${repo}/git/ref/heads/${encodeRef(r.baseBranch).replace(/%2F/g, "/")}`);
    if (head?.object?.sha !== r.base) throw new WriteError(`${repo}'s ${r.baseBranch} moved since the plan: plan again`);
    /** @type {string | null} */
    let made = null;
    try {
      made = String((await deps.getJson(`repos/${POLICY_ORG}/${repo}/git/ref/heads/${r.branch}`))?.object?.sha);
    } catch (e) {
      if (!(e instanceof GhError && e.status === 404)) throw e;
    }
    if (made) {
      // An earlier Open made the branch and stopped before its pull request: open that, if the
      // branch is still the one commit on this base it made. Anything else is not ours to reuse.
      const c = await deps.getJson(`repos/${POLICY_ORG}/${repo}/git/commits/${made}`);
      const parents = Array.isArray(c?.parents) ? c.parents.map((/** @type {any} */ p) => p?.sha) : [];
      if (parents.length !== 1 || parents[0] !== r.base || c?.message !== r.prTitle) {
        throw new WriteError(`${repo} already has a branch ${r.branch} with no open pull request: delete it on GitHub, then plan again`);
      }
      const pr = await deps.ghWrite(`repos/${POLICY_ORG}/${repo}/pulls`, { title: r.prTitle, head: r.branch, base: r.baseBranch, body: r.prBody });
      return String(pr.html_url);
    }
    const commit = await deps.getJson(`repos/${POLICY_ORG}/${repo}/git/commits/${r.base}`);
    const tree = await deps.ghWrite(`repos/${POLICY_ORG}/${repo}/git/trees`, {
      base_tree: commit?.tree?.sha,
      tree: r.changes.map((c) => c.content === null
        ? { path: c.path, mode: c.mode, type: "blob", sha: null }
        : { path: c.path, mode: c.mode, type: "blob", content: c.content }),
    });
    const created = await deps.ghWrite(`repos/${POLICY_ORG}/${repo}/git/commits`, { message: r.prTitle, tree: tree.sha, parents: [r.base] });
    await deps.ghWrite(`repos/${POLICY_ORG}/${repo}/git/refs`, { ref: `refs/heads/${r.branch}`, sha: created.sha });
    const pr = await deps.ghWrite(`repos/${POLICY_ORG}/${repo}/pulls`, { title: r.prTitle, head: r.branch, base: r.baseBranch, body: r.prBody });
    return String(pr.html_url);
  }

  /**
   * @param {() => Promise<Record<string, unknown>>} fn
   * @returns {Promise<import("./server.mjs").Result>}
   */
  async function exclusive(fn) {
    if (busy) return { ok: false, status: 409, error: "another plan or pull request is still being made: wait for it" };
    busy = true;
    try {
      return /** @type {import("./server.mjs").Result} */ (await fn());
    } catch (e) {
      if (e instanceof WriteError || e instanceof GhError || e instanceof EditError) return { ok: false, error: e.message };
      throw e;
    } finally {
      busy = false;
    }
  }

  return {
    /** @param {unknown} body */
    plan: (body) => exclusive(async () => {
      const req = checkRequest(body);
      const { steps, ready } = await makePlan(req);
      const id = randomBytes(12).toString("hex");
      const now = (deps.now ?? (() => new Date()))().getTime();
      for (const [k, p] of plans) if (now - p.at > PLAN_MS) plans.delete(k);
      plans.set(id, { at: now, ready, steps });
      return { ok: true, id, op: req.op, repo: req.repo, steps };
    }),
    /** @param {unknown} body */
    open: (body) => exclusive(async () => {
      const b = /** @type {Record<string, unknown>} */ (typeof body === "object" && body !== null ? body : {});
      const now = (deps.now ?? (() => new Date()))().getTime();
      const found = typeof b.id === "string" ? plans.get(b.id) : undefined;
      const p = found && now - found.at <= PLAN_MS ? found : undefined;
      if (!p) throw new WriteError("that plan is gone (they last 30 minutes): plan again");
      const r = typeof b.step === "string" ? p.ready.get(b.step) : undefined;
      if (!r) throw new WriteError("that step has nothing to open");
      const url = await open(r);
      p.ready.delete(/** @type {string} */ (b.step));
      return { ok: true, url };
    }),
    /** Remove the scratch folder now (also done when the process exits). */
    close: () => root && rm(root, { recursive: true, force: true }),
  };
}
