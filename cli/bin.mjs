#!/usr/bin/env node
// @ts-check
// qq-setup: set up quirq infra (qq) for a GitHub org. The terminal checks your tools, a local form
// in your browser asks which org and repos, and the terminal shows the plan.
// THIS BUILD IS READ-ONLY: it reads GitHub through your gh login and writes nothing anywhere.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listOrgs, listRepos } from "./facts.mjs";
import { getJson, GhError, isName } from "./gh.mjs";
import { buildPlan, checkAnswers, CONFIG_REPO } from "./plan.mjs";
import { preflight } from "./preflight.mjs";
import { startServer } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const IDLE_MS = 30 * 60 * 1000;

const HELP = `qq-setup: set up quirq infra (qq) for your GitHub org.

  npx github:quirq-ai/setup [--no-browser]

Checks your tools and gh login, opens a form on 127.0.0.1 where you pick an org and repos,
then prints the plan here. This version only reads: it changes nothing on GitHub.

  --no-browser   print the form's link instead of opening it
  --version      print the version
  --help         this text`;

const bold = (/** @type {string} */ s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[1m${s}\x1b[0m` : s);

async function main(argv = process.argv.slice(2)) {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const known = new Set(["--no-browser", "--version", "--help", "-h"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`qq-setup: unknown option ${unknown[0]}\n\n${HELP}`);
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) return console.log(HELP), 0;
  if (argv.includes("--version")) return console.log(`qq-setup ${pkg.version}`), 0;

  console.log(`${bold("qq-setup")} ${pkg.version}: sets up quirq infra (qq) for a GitHub org.`);
  console.log("This version only reads from GitHub. Nothing is created or changed.\n");

  const results = await preflight();
  for (const c of results) console.log(`  ${c.ok ? "ok  " : c.fatal ? "FAIL" : "note"}  ${c.name}: ${c.detail}`);
  if (results.some((c) => !c.ok && c.fatal)) {
    console.error("\nqq-setup: fix the FAIL lines above, then run it again.");
    return 1;
  }

  const login = results.find((c) => c.name === "gh login")?.detail.replace(/^logged in as /, "") ?? "";
  console.log("\nReading your GitHub orgs...");
  const orgs = await listOrgs();
  if (!orgs.some((o) => o.usable)) {
    console.error(`qq-setup: ${login} owns no GitHub org. qq needs an org (GitHub has no merge queue for personal accounts):`);
    console.error("create one at https://github.com/account/organizations/new, then run this again.");
    return 1;
  }

  /** @type {Map<string, import("./facts.mjs").Repo[]>} */
  const listed = new Map();
  /** @type {(v: import("./plan.mjs").Answers) => void} */
  let gotAnswers = () => {};
  const answered = new Promise((ok) => (gotAnswers = ok));

  const form = await startServer({
    root: join(ROOT, "out"),
    handlers: {
      state: async () => ({ version: pkg.version, readOnly: true, login, orgs }),
      repos: async (org) => {
        const o = orgs.find((x) => x.login === org);
        if (!o) return { error: "not one of your orgs" };
        if (!o.usable) return { error: `${o.login}: ${o.reason}` };
        const r = await listRepos(o.login);
        listed.set(o.login, r.repos);
        return r;
      },
      submit: async (body) => {
        const checked = checkAnswers(body, orgs, (o) => listed.get(o));
        if (!checked.ok) return checked;
        gotAnswers(checked.answers);
        return { ok: true };
      },
    },
  });

  const noBrowser = argv.includes("--no-browser");
  console.log(`\n${noBrowser ? "Open this link" : "Opening your browser. If it does not open, use this link"} (it works only on this machine):`);
  console.log(`  ${bold(form.url)}\n`);
  if (!noBrowser) openBrowser(form.url);
  console.log("Waiting for the form. Ctrl-C stops.");

  let timer;
  const idle = new Promise((ok) => (timer = setTimeout(() => ok(null), IDLE_MS)));
  const answers = await Promise.race([answered, idle]);
  clearTimeout(timer);
  // Let the page receive its "go back to the terminal" answer before the server stops.
  await new Promise((ok) => setTimeout(ok, 300));
  form.close();
  if (!answers) {
    console.error("qq-setup: no answer from the form in 30 minutes; stopped. Run it again when ready.");
    return 1;
  }

  const a = /** @type {import("./plan.mjs").Answers} */ (answers);
  const configExists = await repoExists(a.org, CONFIG_REPO);
  const plan = buildPlan(a, listed.get(a.org) ?? [], configExists);
  console.log(`\n${bold(`Plan for ${a.org}`)}`);
  plan.does.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  console.log(`\n${bold("Not set up yet")} (qq does not do these for other orgs yet):`);
  for (const line of plan.later) console.log(`  - ${line}`);
  console.log(`\n${bold("Nothing was changed.")} This version stops at the plan; the version that carries it out comes next.`);
  return 0;
}

/** @param {string} org @param {string} repo */
async function repoExists(org, repo) {
  if (!isName(org) || !isName(repo)) return false;
  try {
    await getJson(`repos/${org}/${repo}`);
    return true;
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return false;
    throw e;
  }
}

/** Open the link with the platform's opener; never through a shell. @param {string} url */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  execFile(cmd, args, { timeout: 10_000 }, () => {}); // failure is fine: the link is printed
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(`qq-setup: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2); // exit codes as gate and installer use them: 0 done, 1 not ready or stopped, 2 error
  },
);
