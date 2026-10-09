#!/usr/bin/env node
// @ts-check
// qq-setup: set up quirq infra (qq) for a GitHub org, or put qq on this machine to work on a repo that
// already uses it. The terminal checks your tools, a local form in your browser asks which, and the
// terminal shows the plan or prints the install commands.
// THIS BUILD IS READ-ONLY: it reads GitHub through your gh login and writes nothing anywhere.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listOrgs, listRepos } from "./facts.mjs";
import { getJson, GhError, isName } from "./gh.mjs";
import { buildPlan, checkAnswers, CONFIG_REPO } from "./plan.mjs";
import { preflight } from "./preflight.mjs";
import { protectionWarnings, readProtection } from "./protection.mjs";
import { openerBase, openFile, writeOpener } from "./opener.mjs";
import { startServer } from "./server.mjs";
import { ACCESS, checkTools, INSTALL, MAC, NEEDS, toolsText, commandsFor } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
// The form gives up after 30 minutes with no request from the page.
const IDLE_MS = 30 * 60 * 1000;

const HELP = `qq-setup: set up quirq infra (qq) for your GitHub org, or install qq to work on a repo that uses it.

  npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/<commit> [--no-browser] [--port N]

<commit> is the full id of the latest commit on https://github.com/quirq-ai/setup/commits/main.
npm 12 runs a package from a tarball link only with --allow-remote=root.

Checks your tools and gh login, then opens a form on 127.0.0.1 with two choices:
  - set up repos in an org you own: pick the org and repos, and the plan prints here;
  - work on a repo that already uses qq: the commands that install qq print here.
This version only reads: it changes nothing on GitHub and installs nothing.

  --no-browser   print the form's link instead of opening it
  --port N       serve the form on 127.0.0.1:N (default: a free port). Over SSH, forward the
                 same port number:  ssh -L N:127.0.0.1:N <host>, then open the printed link
  --version      print the version
  --help         this text`;

const bold = (/** @type {string} */ s) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[1m${s}\x1b[0m` : s);

async function main(argv = process.argv.slice(2)) {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const known = new Set(["--no-browser", "--version", "--help", "-h"]);
  let port = 0;
  /** @type {string[]} */
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        console.error("qq-setup: --port needs a number from 1024 to 65535");
        return 2;
      }
    } else if (!known.has(argv[i])) unknown.push(argv[i]);
  }
  if (unknown.length) {
    console.error(`qq-setup: unknown option ${unknown[0]}\n\n${HELP}`);
    return 2;
  }
  if (argv.includes("--help") || argv.includes("-h")) return console.log(HELP), 0;
  if (argv.includes("--version")) return console.log(`qq-setup ${pkg.version}`), 0;

  console.log(`${bold("qq-setup")} ${pkg.version}: sets up quirq infra (qq) for a GitHub org, or shows how to install qq.`);
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
    console.log(`  note  ${login} owns no GitHub org, so the form can only show how to install qq. To set up repos,`);
    console.log("        create a free org at https://github.com/account/organizations/new, move your repos into it");
    console.log("        (each repo's Settings > General > Transfer ownership), then run this again.");
  }

  /** @type {Map<string, import("./facts.mjs").Repo[]>} */
  const listed = new Map();
  /** @type {(v: import("./plan.mjs").Answers | { tools: string | null }) => void} */
  let gotAnswers = () => {};
  const answered = new Promise((ok) => (gotAnswers = ok));
  let accepted = false;
  /** @type {(v: null) => void} */
  let idleOut = () => {};
  const idle = new Promise((ok) => (idleOut = ok));
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idleOut(null), IDLE_MS);
  };

  /** @type {() => void} */
  let removeOpener = () => {};
  // Set once a page has traded the key, so a slow auto-open never launches a browser on a dead link.
  let traded = false;
  let refused = 0;
  const form = await startServer({
    root: join(ROOT, "out"),
    port,
    // The page has traded the key: the redirect page is no longer needed.
    onSession: () => {
      traded = true;
      removeOpener();
      const at = new Date().toTimeString().slice(0, 8);
      console.log(`The form was opened in a browser (${at}). If that was not you, press Ctrl-C.`);
    },
    // Once, then only at 10, 100, 1000…: a flood of tries cannot push the Ctrl-C warning off screen.
    onRefusedTrade: () => {
      refused++;
      if (refused === 1) console.log("Someone tried the link again; it was refused.");
      else if (Number.isInteger(Math.log10(refused))) console.log(`The link has now been tried again ${refused} times; all refused.`);
    },
    handlers: {
      state: async () => (touch(), { version: pkg.version, readOnly: true, login, orgs, platform: process.platform,
        tools: { install: INSTALL, ...commandsFor(process.platform), needs: NEEDS, mac: MAC, access: ACCESS } }),
      repos: async (org) => {
        touch();
        const o = orgs.find((x) => x.login === org);
        if (!o) return { error: "not one of your orgs" };
        if (!o.usable) return { error: `${o.login}: ${o.reason}` };
        const r = await listRepos(o.login);
        listed.set(o.login, r.repos);
        return r;
      },
      submit: async (body) => {
        touch();
        if (accepted) return { ok: false, status: 409, error: "already answered: the terminal has your first answers" };
        if (body && typeof body === "object" && "mode" in body) {
          const t = checkTools(body);
          if (!t.ok) return t;
          accepted = true;
          gotAnswers({ tools: t.repo });
          return { ok: true };
        }
        const checked = checkAnswers(body, orgs, (o) => listed.get(o));
        if (!checked.ok) return checked;
        // The form only knows the 100 most recently pushed repos: ask GitHub about the new name itself.
        const st = checked.answers.starter;
        if (st && (await repoExists(checked.answers.org, st.name))) {
          return { ok: false, error: `${st.name} already exists in ${checked.answers.org}` };
        }
        if (accepted) return { ok: false, status: 409, error: "already answered: the terminal has your first answers" };
        accepted = true;
        gotAnswers(checked.answers);
        return { ok: true };
      },
    },
  });

  const noBrowser = argv.includes("--no-browser");
  console.log(noBrowser
    ? "\nOpen this link (it works once, and only on this machine):"
    : "\nOpening your browser. If it does not open, shows a file-not-found or access-denied page, or opens an editor,\nuse this link instead (it works once, and only on this machine):");
  console.log(`  ${bold(form.url)}\n`);
  if (!noBrowser) {
    // The opener sees only a file path, never the key (cli/opener.mjs).
    /** @type {Awaited<ReturnType<typeof writeOpener>> | null} */
    let opener = null;
    try {
      opener = await writeOpener(form.url, await openerBase());
    } catch {
      console.log("  (Could not prepare the page that opens your browser; use the link above.)");
    }
    // Finding the folder can take a few seconds. If the printed link was used meanwhile, the key is
    // dead: remove the page and open nothing.
    if (opener && traded) opener.remove();
    else if (opener) {
      const page = opener;
      removeOpener = page.remove;
      process.once("exit", page.remove);
      // Clean up, then die by the same signal, so a shell sees what it would have without us.
      for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
        process.once(sig, () => {
          page.remove();
          process.kill(process.pid, sig);
        });
      }
      openFile(page.path);
    }
  }
  console.log("Waiting for the form. Ctrl-C stops.");

  touch();
  const answers = await Promise.race([answered, idle]);
  clearTimeout(timer);
  // Let the page receive its "go back to the terminal" answer before the server stops.
  await new Promise((ok) => setTimeout(ok, 300));
  form.close();
  removeOpener();
  if (!answers) {
    console.error("qq-setup: no answer from the form for 30 minutes; stopped. Run it again when ready.");
    return 1;
  }

  if ("tools" in answers) {
    console.log("");
    for (const line of toolsText(answers.tools, process.platform)) console.log(line);
    console.log(`\n${bold("Nothing was installed.")} qq-setup only printed the commands; run them yourself.`);
    return 0;
  }
  const a = answers;
  const repos = listed.get(a.org) ?? [];
  if (a.repos.length) {
    console.log(`\n${bold("What already guards these repos")} (read only; setup would check again before writing):`);
    for (const name of a.repos) {
      const branch = repos.find((r) => r.name === name)?.defaultBranch ?? "main";
      const warnings = protectionWarnings(branch, await readProtection(a.org, name, branch));
      if (!warnings.length) console.log(`  ${name}: no existing protection found`);
      else for (const w of warnings) console.log(`  ${name}: warning: ${w}`);
    }
  }
  const configExists = await repoExists(a.org, CONFIG_REPO);
  const plan = buildPlan(a, repos, configExists);
  console.log(`\n${bold(`Plan for ${a.org}`)}`);
  plan.does.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  console.log(`\n${bold("Not set up yet, and good to know")}:`);
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

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(`qq-setup: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2); // exit codes as gate and installer use them: 0 done, 1 not ready or stopped, 2 error
  },
);
