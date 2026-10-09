// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { detectKinds } from "../cli/detect.mjs";
import { encodeRef, ghEnv, GhError, isName } from "../cli/gh.mjs";
import { buildPlan, checkAnswers } from "../cli/plan.mjs";
import { checks } from "../cli/preflight.mjs";
import { listRepos } from "../cli/facts.mjs";
import { classicFromError, protectionWarnings } from "../cli/protection.mjs";
import { isBlankRepo, normalizeRepo, parseRepo } from "../cli/names.mjs";
import { checkTools, commandsFor, getLine, INSTALL, MAC, toolsText } from "../cli/tools.mjs";
import { openerBase, writeOpener } from "../cli/opener.mjs";
import { startServer } from "../cli/server.mjs";

test("detectKinds offers a kind only when kinds.toml's stand-in commands will run", () => {
  const next = { dependencies: { next: "16.3.8" }, scripts: { build: "next build", typecheck: "tsc --noEmit" } };
  assert.deepEqual(detectKinds(["requirements.txt", "requirements-dev.txt", "tests"], { requirementsDev: "pytest==8.4\nruff\n" }).kinds,
    ["python-service", "pytest"]);
  assert.deepEqual(detectKinds(["requirements-dev.txt", "test_app.py"], { requirementsDev: "pytest\n" }).kinds, ["pytest"]);
  const noTests = detectKinds(["requirements-dev.txt", "app.py"], { requirementsDev: "pytest\n" });
  assert.deepEqual(noTests.kinds, []);
  assert.match(noTests.notes[0], /no tests\/ directory/);
  assert.deepEqual(detectKinds(["package.json", "pnpm-lock.yaml"], { packageJson: next }).kinds, ["node-app"]);
  assert.deepEqual(detectKinds(["package.json", "pnpm-lock.yaml"],
    { packageJson: { dependencies: { gatsby: "4" }, scripts: { build: "gatsby build", test: "node --test" } } }).kinds, ["gatsby-site"]);

  const nothing = detectKinds(["Package.swift", "README.md"]);
  assert.deepEqual(nothing.kinds, []);
  assert.match(nothing.notes[0], /^no requirements\.txt, requirements-dev\.txt or package\.json at the root/);

  const noPytest = detectKinds(["requirements-dev.txt"], { requirementsDev: "ruff\n# pytest later\n" });
  assert.deepEqual(noPytest.kinds, []);
  assert.match(noPytest.notes[0], /does not list pytest/);
  const npmNext = detectKinds(["package.json", "package-lock.json"], { packageJson: next });
  assert.deepEqual(npmNext.kinds, []);
  assert.match(npmNext.notes[0], /pnpm-lock\.yaml/);
  const noTypecheck = detectKinds(["package.json", "pnpm-lock.yaml"], { packageJson: { dependencies: { next: "16" }, scripts: { build: "x" } } });
  assert.deepEqual(noTypecheck.kinds, []);
  assert.match(noTypecheck.notes[0], /"typecheck" script/);
  assert.match(detectKinds(["pyproject.toml"]).notes[0], /requirements/);
  assert.equal(detectKinds(["infra"], { hasManifest: true }).onQq, true);
  assert.match(detectKinds(["package.json"], { packageJson: null }).notes[0], /could not be read/);
});

test("ghEnv never passes a token variable or a host override to gh", () => {
  const env = ghEnv({ GH_TOKEN: "x", GITHUB_TOKEN: "y", GH_ENTERPRISE_TOKEN: "z", GH_HOST: "evil.example", PATH: "/bin" });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.GH_HOST, undefined);
  assert.equal(env.PATH, "/bin");
});

test("isName and encodeRef keep API paths to safe characters", () => {
  assert.ok(isName("quirq-ai"));
  assert.ok(isName("my.repo_1"));
  for (const bad of ["", "../x", "a/b", "-x", "x.git", "x.GIT", "a b", "a?b", 3]) assert.ok(!isName(bad), String(bad));
  assert.equal(encodeRef("feature/x(1)"), "feature%2Fx%281%29");
});

const orgs = [
  { login: "acme", role: "admin", usable: true },
  { login: "other", role: "member", usable: false, reason: "you are not an owner of this org" },
];
const repos = [
  { name: "api", visibility: "public", archived: false, fork: false, defaultBranch: "main",
    kinds: /** @type {any} */ (["python-service", "pytest"]), onQq: false, usable: true, notes: [] },
  { name: "web", visibility: "public", archived: false, fork: false, defaultBranch: "main",
    kinds: /** @type {any} */ (["node-app"]), onQq: true, usable: true, notes: [] },
  { name: "secret", visibility: "private", archived: false, fork: false, defaultBranch: "main",
    kinds: [], onQq: false, usable: false, reason: "private", notes: [] },
];
const reposOf = (/** @type {string} */ o) => (o === "acme" ? repos : undefined);

test("checkAnswers accepts only what the command offered", () => {
  const ok = checkAnswers({ org: "acme", repos: ["web", "api", "web"], starter: null }, orgs, reposOf);
  assert.deepEqual(ok, { ok: true, answers: { org: "acme", repos: ["api", "web"], starter: null } });

  const cases = [
    [null, /JSON object/],
    [{ org: "acme", repos: [], starter: null, token: "x" }, /unexpected field/],
    [{ org: "nope", repos: ["api"] }, /pick one of your orgs/],
    [{ org: "other", repos: [] }, /not an owner/],
    [{ org: "acme", repos: ["secret"] }, /private/],
    [{ org: "acme", repos: ["ghost"] }, /not a repo the form offered/],
    [{ org: "acme", repos: "api" }, /list of names/],
    [{ org: "acme", repos: [] }, /at least one/],
    [{ org: "acme", repos: [], starter: { name: "../x", kind: "node-app" } }, /letters, digits/],
    [{ org: "acme", repos: [], starter: { name: "API", kind: "node-app" } }, /already exists/],
    [{ org: "acme", repos: [], starter: { name: "qq-config", kind: "node-app" } }, /already exists/],
    [{ org: "acme", repos: [], starter: { name: "new", kind: "rust" } }, /offered templates/],
    // Built-in object keys are not templates (independent review S-1).
    ...["constructor", "toString", "__proto__", "hasOwnProperty"].map((kind) =>
      [{ org: "acme", repos: [], starter: { name: "new", kind } }, /offered templates/]),
  ];
  for (const [body, re] of cases) {
    const r = checkAnswers(body, orgs, reposOf);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(/** @type {{ error: string }} */ (r).error, /** @type {RegExp} */ (re));
  }
  const unlisted = checkAnswers({ org: "acme", repos: ["api"] }, orgs, () => undefined);
  assert.equal(unlisted.ok, false);
});

test("buildPlan names every write, and what v0 leaves out", () => {
  const plan = buildPlan({ org: "acme", repos: ["api", "web"], starter: { name: "new", kind: "node-app" } }, repos, false);
  const text = plan.does.join("\n");
  assert.match(plan.does[1], /^Create acme\/qq-config/);
  assert.match(text, /Create acme\/new \(public\) from the Next\.js 16 app/);
  assert.match(text, /acme\/api \(python-service, pytest\): add infra\/repo\.toml/);
  assert.match(text, /acme\/web \(node-app\): keep its infra\/repo\.toml, add the generated/);
  assert.match(plan.does[0], /^Right before writing, read each repo's merge settings, rulesets and branch protection again/);
  assert.match(plan.does[0], /this version read them once/);
  assert.match(text, /only when its presubmit is green and no review is required; otherwise leave it open/);
  assert.doesNotMatch(text, /merge it once its presubmit is green/);
  for (const r of ["api", "web", "new"]) assert.match(text, new RegExp(`Protect acme/${r}'s default branch`));
  assert.match(plan.later.join("\n"), /canary/);
  assert.match(plan.later.join("\n"), /honour-based/);
  assert.match(plan.later.join("\n"), /qq land does not know your repos/);
  assert.match(plan.later.join("\n"), /To undo setup: delete the qq-main and qq-reserved-tags rulesets/);
  assert.match(buildPlan({ org: "acme", repos: ["api"], starter: null }, repos, true).does[1], /^Update acme\/qq-config \(only if setup created it; otherwise setup stops\)/);
});

test("preflight checks: token variables, scopes, Python and macOS", () => {
  const base = { node: "v24.1.0", platform: "linux", env: {}, git: "git version 2.50", gh: "gh version 2.89",
    python: "Python 3.14.8", login: "sam", scopes: ["repo", "workflow", "read:org", "gist"], loginError: null };
  assert.ok(checks(base).every((c) => c.ok));

  const tok = checks({ ...base, env: { GH_TOKEN: "x" } }).find((c) => c.name === "No token variables");
  assert.equal(tok?.ok, false);
  assert.equal(tok?.fatal, true);
  assert.doesNotMatch(tok?.detail ?? "", /x$/);

  const scopes = checks({ ...base, scopes: ["repo"] }).find((c) => c.name === "gh scopes");
  assert.equal(scopes?.ok, false);
  assert.match(scopes?.detail ?? "", /gh auth refresh -h github\.com -s read:org$/);
  // gh's default login (repo, read:org, gist) is enough for this build; workflow is a note for later.
  const dflt = checks({ ...base, scopes: ["repo", "read:org", "gist"] });
  assert.ok(dflt.every((c) => c.ok || !c.fatal));
  assert.match(dflt.find((c) => c.name === "Scope for the setup step")?.detail ?? "", /^not needed for this version; .*--remove-scopes workflow/);
  for (const c of checks(base)) assert.doesNotMatch(c.detail, /admin:org|delete_repo|-s gist/);

  const mac = checks({ ...base, platform: "darwin", python: "Python 3.9.6" });
  assert.match(mac.find((c) => c.name === "Python 3.11+")?.detail ?? "", /brew install python@3\.14/);
  assert.equal(mac.find((c) => c.name === "Python 3.11+")?.fatal, false);
  assert.match(mac.find((c) => c.name === "macOS")?.detail ?? "", /Linux x86_64 only.*no pin for platform.*clone with git.*--toolchain NAME=ROOT/);

  assert.equal(checks({ ...base, node: "v20.11.0" })[0].ok, false);
  const out = checks({ ...base, login: null, loginError: "not logged in" }).find((c) => c.name === "gh login");
  assert.equal(out?.ok, false);
  assert.equal(out?.detail, "not logged in: run  gh auth login");
});

/**
 * @param {number} port
 * @param {{ method?: string, path: string, host?: string, headers?: Record<string, string>, body?: string }} o
 * @returns {Promise<{ status: number, body: string, headers: import("node:http").IncomingHttpHeaders }>}
 */
function hit(port, o) {
  return new Promise((ok, fail) => {
    const req = request(
      { host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path,
        headers: { host: o.host ?? `127.0.0.1:${port}`, ...(o.headers ?? {}) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", fail);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/**
 * Trade the link's key for the session cookie, as the page does; returns the headers the page then
 * sends on every call.
 * @param {number} port @param {string} key
 */
async function openSession(port, key) {
  const origin = `http://127.0.0.1:${port}`;
  const res = await hit(port, { method: "POST", path: "/api/session", headers: { origin, "x-qq-setup": "1", "x-qq-setup-key": key } });
  assert.equal(res.status, 200, res.body);
  const set = String(res.headers["set-cookie"] ?? "");
  const { token } = JSON.parse(res.body);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  return { set, token, headers: { origin, "x-qq-setup": token, cookie: set.split(";")[0] } };
}

test("server: single-use key, session cookie, host, origin, body size and static files", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-setup-test-"));
  await mkdir(join(root, "out"));
  await writeFile(join(root, "out", "index.html"), "<p>form</p>");
  await writeFile(join(root, "secret.txt"), "outside");
  /** @type {unknown[]} */
  const submitted = [];
  let sessions = 0;
  let refused = 0;
  const srv = await startServer({
    root: join(root, "out"),
    onSession: () => sessions++,
    onRefusedTrade: () => refused++,
    handlers: {
      state: async () => ({ hello: "world" }),
      repos: async (org) => ({ org }),
      submit: async (b) =>
        submitted.length ? { ok: false, status: 409, error: "already answered" } : (submitted.push(b), { ok: true }),
    },
  });
  try {
    const p = srv.port;
    const origin = `http://127.0.0.1:${p}`;
    assert.ok(srv.url.startsWith(`http://127.0.0.1:${p}/#key=`));

    const page = await hit(p, { path: "/" });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<p>form</p>");
    assert.match(String(page.headers["content-security-policy"]), /connect-src 'self'/);

    // Before the key is traded, nothing opens the API: not the key itself, not a guessed cookie.
    const x = { "x-qq-setup": "1" };
    assert.equal((await hit(p, { path: "/api/state" })).status, 403);
    assert.equal((await hit(p, { path: "/api/state", headers: x })).status, 401);
    assert.equal((await hit(p, { path: "/api/state", headers: { ...x, "x-qq-setup-key": srv.key } })).status, 401);
    assert.equal((await hit(p, { path: "/api/state", headers: { ...x, cookie: `qq_setup_${p}=` } })).status, 401);
    // The trade needs our origin, the header and the right key.
    const trade = (/** @type {Record<string, string>} */ h) => hit(p, { method: "POST", path: "/api/session", headers: h });
    assert.equal((await trade({ origin, "x-qq-setup-key": srv.key })).status, 403);
    assert.equal((await trade({ ...x, "x-qq-setup-key": srv.key })).status, 403);
    assert.equal((await trade({ ...x, origin: "http://127.0.0.1:1", "x-qq-setup-key": srv.key })).status, 403);
    assert.equal((await trade({ ...x, origin, "x-qq-setup-key": "wrong" })).status, 403);
    assert.equal(sessions, 0);
    const { set, token, headers: k } = await openSession(p, srv.key);
    assert.equal(sessions, 1);
    assert.equal(refused, 0);
    assert.match(set, new RegExp(`^qq_setup_${p}=[A-Za-z0-9_-]{43}; Path=/api; HttpOnly; SameSite=Strict$`));
    // Single-use: the same key again, from anyone, gets nothing.
    assert.equal((await trade({ ...x, origin, "x-qq-setup-key": srv.key })).status, 403);
    assert.equal(sessions, 1);
    assert.equal(refused, 1);
    // The cookie reaches every port on 127.0.0.1, so on its own it opens nothing: the token from the
    // trade, kept in the tab's sessionStorage, is needed too. And the token alone opens nothing either.
    assert.equal((await hit(p, { path: "/api/state", headers: { ...x, cookie: k.cookie } })).status, 401);
    assert.equal((await hit(p, { path: "/api/state", headers: { "x-qq-setup": token } })).status, 401);
    assert.equal((await hit(p, { path: "/api/state", headers: { ...k, "x-qq-setup": `${token}x` } })).status, 401);
    // A same-named cookie set from another port and sent first does not lock the real page out.
    const tossed = { ...k, cookie: `qq_setup_${p}=junk; ${k.cookie}` };
    assert.equal((await hit(p, { path: "/api/state", headers: tossed })).status, 200);

    assert.equal((await hit(p, { path: "/api/state", headers: k })).body, JSON.stringify({ hello: "world" }));
    assert.equal((await hit(p, { path: "/api/state", headers: { cookie: k.cookie } })).status, 403); // no x-qq-setup
    assert.equal((await hit(p, { path: "/api/state", headers: { ...k, cookie: `${k.cookie}x` } })).status, 401);
    assert.equal((await hit(p, { path: "/api/state", headers: k, host: `localhost:${p}` })).status, 421);
    assert.equal((await hit(p, { path: "/api/state", headers: { ...k, origin: "http://evil.example" } })).status, 403);
    assert.equal((await hit(p, { path: "/api/state", headers: { ...k, origin: "http://127.0.0.1:1" } })).status, 403);

    assert.equal((await hit(p, { path: "/../secret.txt" })).status, 404);
    assert.equal((await hit(p, { path: "/%2e%2e/secret.txt" })).status, 404);
    assert.equal((await hit(p, { method: "POST", path: "/" })).status, 405);

    const post = (/** @type {string} */ body, /** @type {Record<string, string>} */ h = {}) =>
      hit(p, { method: "POST", path: "/api/answers", headers: { ...k, "content-type": "application/json", ...h }, body });
    const noOrigin = { "x-qq-setup": token, cookie: k.cookie, "content-type": "application/json" };
    assert.equal((await hit(p, { method: "POST", path: "/api/answers", headers: noOrigin, body: "{}" })).status, 403);
    assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post(JSON.stringify({ pad: "x".repeat(20_000) }))).status, 413);
    assert.equal((await post(JSON.stringify({ org: "acme" }))).status, 200);
    const again = await post(JSON.stringify({ org: "other" }));
    assert.equal(again.status, 409);
    assert.deepEqual(JSON.parse(again.body), { ok: false, error: "already answered" });
    assert.deepEqual(submitted, [{ org: "acme" }]);
  } finally {
    srv.close();
  }
});

test("protectionWarnings: clean, unknown never reads as clean, and classic protection", () => {
  assert.deepEqual(protectionWarnings("main", { squash: true, rulesets: [], classic: "none" }), []);
  assert.deepEqual(protectionWarnings("main", { squash: true, rulesets: ["qq-main"], classic: "none" }), []);

  const unknown = protectionWarnings("main", { squash: null, rulesets: null, classic: "unreadable" });
  assert.equal(unknown.length, 3);
  assert.match(unknown.join("\n"), /could not read the merge settings/);
  assert.match(unknown.join("\n"), /could not read its rulesets/);
  assert.match(unknown.join("\n"), /could not read main's branch protection/);

  // Only GitHub's "Branch not protected" 404 means none; a plain 404 or a 403 is unreadable.
  assert.equal(classicFromError(new GhError("gh api failed: gh: Branch not protected (HTTP 404)", 404)), "none");
  assert.equal(classicFromError(new GhError("gh api failed: gh: Not Found (HTTP 404)", 404)), "unreadable");
  assert.equal(classicFromError(new GhError("gh api failed: gh: Must have admin rights to Repository. (HTTP 403)", 403)), "unreadable");
  assert.equal(classicFromError(new Error("timeout")), "unreadable");

  const legacy = protectionWarnings("trunk", {
    squash: false, rulesets: ["release-freeze", "qq-main"], classic: { checks: ["build", "lint"], reviews: 2 } });
  assert.match(legacy[0], /squash merging is off/);
  assert.match(legacy[1], /other rulesets apply \(release-freeze\)/);
  assert.match(legacy[2], /^trunk has classic branch protection/);
  assert.match(legacy[3], /\(build, lint\) must also run on merge_group/);
  assert.match(legacy[4], /requires 2 approving reviews: setup would leave its pull request open/);
});

test("listRepos: quirq-ai's own tool repos are named as part of qq, and an empty reason is explained", async () => {
  const fakeGh = fileURLToPath(new URL("./fake-gh", import.meta.url));
  const saved = process.env.PATH;
  const log = join(mkdtempSync(join(tmpdir(), "qq-setup-test-")), "calls.log");
  process.env.PATH = `${fakeGh}${delimiter}${saved}`;
  process.env.FAKE_GH_LOG = log;
  try {
    const { repos } = await listRepos("quirq-ai");
    const by = Object.fromEntries(repos.map((r) => [r.name, r]));
    for (const name of ["gate", "Release"]) { // names compare ignoring case, as GitHub's do
      assert.equal(by[name].usable, false);
      assert.equal(by[name].onQq, false);
      assert.match(by[name].reason ?? "", /^part of qq itself/);
    }
    assert.equal(by["Gate-notes"].reason, "empty repo"); // only the exact tool names, never a lookalike
    assert.match(by["ios-app"].notes[0], /^no requirements\.txt/);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.ok(calls.some((c) => c.startsWith("repos/quirq-ai/ios-app/")), "the log records reads");
    assert.deepEqual(calls.filter((c) => /^repos\/quirq-ai\/(gate|release)(\/|$)/i.test(c)), []); // never read
  } finally {
    process.env.PATH = saved;
    delete process.env.FAKE_GH_LOG;
    rmSync(dirname(log), { recursive: true, force: true });
  }
});

test("checkTools: only mode and an owner/name repo get through", () => {
  assert.deepEqual(checkTools({ mode: "tools", repo: null }), { ok: true, repo: null });
  assert.deepEqual(checkTools({ mode: "tools", repo: "" }), { ok: true, repo: null });
  assert.deepEqual(checkTools({ mode: "tools", repo: "quirq-ai/innernet" }), { ok: true, repo: "quirq-ai/innernet" });
  // A pasted link or a clone URL is accepted as the owner/name it names.
  for (const pasted of ["https://github.com/quirq-ai/innernet", "https://github.com/quirq-ai/innernet/",
    "https://github.com/quirq-ai/innernet.git", "quirq-ai/innernet.git", " quirq-ai/innernet "]) {
    assert.deepEqual(checkTools({ mode: "tools", repo: pasted }), { ok: true, repo: "quirq-ai/innernet" }, pasted);
  }
  assert.equal(normalizeRepo("http://github.com/a/b"), "http://github.com/a/b"); // only https is unwrapped
  const refused = ["innernet", "a/b/c", "../x", "a/-b", "a b/c", "a/b;rm", "$(id)/x", "a/b.git.git",
    "a/b\r", "a\n/b", "a/b\r\nevil", "a/b\u001b[31m", "a/b\u0000", "a/b%0a",
    "\tquirq-ai/innernet", "quirq-ai/innernet\t", "\u00a0quirq-ai/innernet", "\u3000quirq-ai/innernet",
    "q‐ai/x", "а/b", "ｑ/b", "a/b​", "https://evil.example/a/b", "http://github.com/a/b", 7, true, ["a/b"]];
  for (const repo of refused) assert.equal(checkTools({ mode: "tools", repo }).ok, false, JSON.stringify(repo));
  // Blank is spaces only, the same rule the form uses (cli/names.mjs): a tab or NBSP alone is refused.
  for (const blank of ["", " ", "   "]) assert.ok(isBlankRepo(blank) && checkTools({ mode: "tools", repo: blank }).ok);
  for (const notBlank of ["\t", "\u00a0", "\u3000", "\n"]) {
    assert.equal(isBlankRepo(notBlank), false);
    assert.equal(parseRepo(notBlank), null);
    assert.equal(checkTools({ mode: "tools", repo: notBlank }).ok, false, JSON.stringify(notBlank));
  }
  assert.equal(checkTools({ mode: "tools", repo: null, org: "acme" }).ok, false);
  assert.equal(checkTools({ mode: "repos" }).ok, false);
});

test("the install commands are the qq guide's, byte for byte", async () => {
  const fixture = (await readFile(new URL("./fixtures/qq-guide-install.txt", import.meta.url), "utf8"))
    .split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(INSTALL.map((s) => s.cmd), fixture);
});

test("the README says the same about macOS as the page and the terminal", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(readme.includes(MAC), "README.md must contain the MAC text from cli/tools.mjs");
});

test("toolsText: install commands, then the line that gets the repo for this platform", () => {
  const linux = toolsText("quirq-ai/innernet", "linux").join("\n");
  for (const s of INSTALL) assert.ok(linux.includes(s.cmd));
  assert.match(linux, /qq fetch https:\/\/github\.com\/quirq-ai\/innernet\n/);
  assert.doesNotMatch(linux, /no pin for platform/);
  const mac = toolsText("quirq-ai/innernet", "darwin").join("\n");
  assert.match(mac, /git clone https:\/\/github\.com\/quirq-ai\/innernet\n/);
  assert.doesNotMatch(mac, /qq fetch https/);
  assert.match(mac, /qq fetch clones the repo and then stops with "no pin for platform"/);
  assert.match(mac, /--toolchain NAME=ROOT or your PATH, and still check the pinned versions \(exact Python, Node major\); qq run uses your PATH/);
  // On a Mac, qq sync stops, so it is not listed; build, test and run are, with the note.
  assert.doesNotMatch(mac, /^ +qq sync/m);
  assert.match(mac, /Inside it:\n +qq build/);
  assert.match(mac, /^ +qq run "COMMAND" +.*your PATH$/m);
  assert.match(linux, /Inside it:\n +qq sync/);
  for (const p of ["darwin", "linux"]) assert.ok(commandsFor(p).useNote);
  assert.ok(commandsFor("darwin").use.every((u) => !u.cmd.startsWith("qq sync")));
  assert.equal(getLine(null, "linux"), "qq fetch https://github.com/OWNER/NAME");
  // zsh-safe: no comment or history characters in anything a person pastes.
  for (const s of INSTALL) assert.doesNotMatch(s.cmd, /[#!]/);
});

/** Run the real CLI against the fake gh and return its link, output and exit. */
async function runCli({ browser = false, path = "", env: extra = {} } = {}) {
  const env = { ...process.env, PATH: `${path}${fileURLToPath(new URL("./fake-gh", import.meta.url))}${delimiter}${process.env.PATH}`, NO_COLOR: "1", ...extra };
  for (const v of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[v];
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../cli/bin.mjs", import.meta.url)), ...(browser ? [] : ["--no-browser"])], { env });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  proc.stderr.on("data", (c) => (out += c));
  const exited = new Promise((ok) => proc.on("exit", ok));
  const url = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no link from the CLI:\n${out}`)), 15_000);
    proc.stdout.on("data", () => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/#key=([A-Za-z0-9_-]+)/.exec(out);
      if (m) {
        clearTimeout(t);
        ok({ port: Number(m[1]), key: m[2] });
      }
    });
  });
  return { proc, ...url, output: () => out, exited };
}

test("cli: a body with mode never reaches the repos check, and a tools answer is the only answer", async () => {
  const cli = await runCli();
  const { headers: k } = await openSession(cli.port, cli.key);
  const post = (/** @type {unknown} */ body) => hit(cli.port, { method: "POST", path: "/api/answers",
    headers: { ...k, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await hit(cli.port, { path: "/api/repos?org=acme-labs", headers: k });
    // A complete, valid repos answer, but with a mode: refused by the tools check, never planned.
    const routed = await post({ mode: "repos", org: "acme-labs", repos: ["billing-api"], starter: null });
    assert.equal(routed.status, 400);
    assert.match(routed.body, /unexpected field: org/);
    assert.equal((await post({ mode: "tools", repo: "a/b\u001b[31m" })).status, 400);
    assert.equal((await post({ mode: "tools", repo: "https://github.com/quirq-ai/innernet.git" })).status, 200);
    const again = await post({ mode: "tools", repo: null });
    assert.equal(again.status, 409);
    assert.equal((await post({ org: "acme-labs", repos: ["billing-api"], starter: null })).status, 409);
    assert.equal(await cli.exited, 0);
    // The CLI prints the line for the machine it runs on (CI runs this on macOS too).
    assert.ok(cli.output().includes(`${getLine("quirq-ai/innernet", process.platform)}\n`));
    assert.doesNotMatch(cli.output(), /Plan for/);
  } finally {
    cli.proc.kill();
  }
});

test("writeOpener: a 0600 page in a 0700 directory, removed afterwards; only qq-setup links", async () => {
  const url = "http://127.0.0.1:43210/#key=abcdefghijklmnopqrstuvwx";
  const o = await writeOpener(url);
  try {
    if (process.platform !== "win32") { // Windows reports no POSIX modes
      assert.equal(statSync(o.path).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(o.path)).mode & 0o777, 0o700);
    }
    assert.ok(readFileSync(o.path, "utf8").includes(`location.replace(${JSON.stringify(url)})`));
  } finally {
    o.remove();
  }
  assert.equal(existsSync(dirname(o.path)), false);
  o.remove(); // twice is fine
  for (const bad of ["http://evil.example/#key=abc", "http://127.0.0.1:1/#key=a\"<x", "file:///etc/passwd"]) {
    await assert.rejects(writeOpener(bad), /not a qq-setup link/);
  }
});

test("cli: the browser opener's argv holds a file path, never the key", { skip: process.platform === "win32" }, async () => {
  const bin = mkdtempSync(join(tmpdir(), "qq-setup-opener-"));
  const log = join(bin, "argv.log");
  for (const name of ["xdg-open", "open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
  }
  const cli = await runCli({ browser: true, path: `${bin}${delimiter}` });
  try {
    let argv = "";
    for (let i = 0; i < 50 && !argv; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      argv = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
    }
    assert.ok(argv, "the opener ran");
    assert.doesNotMatch(argv, /key=|127\.0\.0\.1/);
    assert.match(argv, /qq-setup-[^/]+\/open\.html$/);
    assert.ok(readFileSync(argv, "utf8").includes(cli.key), "the page it opens holds the link");
    // Once the page trades the key, the redirect page is gone.
    await openSession(cli.port, cli.key);
    assert.equal(existsSync(argv), false);
  } finally {
    cli.proc.kill();
    rmSync(bin, { recursive: true, force: true });
  }
});

test("openerBase: a snap browser gets a folder it can read; anything else gets the temp folder", async () => {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-home-"));
  try {
    mkdirSync(join(home, "snap", "firefox", "common"), { recursive: true });
    const base = (/** @type {string} */ desktop, platform = "linux") =>
      openerBase({ platform, home, defaultBrowser: async () => desktop });
    assert.equal(await base("firefox_firefox.desktop\n"), join(home, "snap", "firefox", "common"));
    assert.equal(await base("chromium_chromium.desktop"), tmpdir()); // no ~/snap/chromium/common here
    assert.equal(await base("firefox.desktop"), tmpdir());
    assert.equal(await base("org.mozilla.firefox.desktop"), tmpdir()); // flatpak: not detected
    assert.equal(await base("../x_y.desktop"), tmpdir());
    assert.equal(await base(""), tmpdir());
    assert.equal(await base("firefox_firefox.desktop", "darwin"), tmpdir());
    const o = await writeOpener("http://127.0.0.1:1234/#key=abcdefghijklmnopqrstuvwx", await base("firefox_firefox.desktop"));
    assert.ok(o.path.startsWith(join(home, "snap", "firefox", "common", "qq-setup-")));
    o.remove();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli: no temp folder means no auto-open, never a failed run; the terminal reports trades", async () => {
  const cli = await runCli({ browser: true, env: { TMPDIR: "/nonexistent-qq-setup-dir", TMP: "/nonexistent-qq-setup-dir", TEMP: "/nonexistent-qq-setup-dir" } });
  try {
    await new Promise((ok) => setTimeout(ok, 300));
    assert.match(cli.output(), /Could not prepare the page that opens your browser; use the link above/);
    assert.equal(cli.proc.exitCode, null, "still waiting for the form");
    await openSession(cli.port, cli.key);
    const again = await hit(cli.port, { method: "POST", path: "/api/session",
      headers: { origin: `http://127.0.0.1:${cli.port}`, "x-qq-setup": "1", "x-qq-setup-key": cli.key } });
    assert.equal(again.status, 403);
    await new Promise((ok) => setTimeout(ok, 100));
    assert.match(cli.output(), /The form was opened in a browser \(\d\d:\d\d:\d\d\)\. If that was not you, press Ctrl-C\./);
    assert.match(cli.output(), /Someone tried the link again; it was refused\./);
  } finally {
    cli.proc.kill();
  }
});

for (const sig of /** @type {const} */ (["SIGTERM", "SIGHUP", "SIGINT"])) {
  test(`cli: ${sig} removes the opener page and still ends the run by that signal`, { skip: process.platform === "win32" }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "qq-setup-opener-"));
    const log = join(bin, "argv.log");
    for (const name of ["xdg-open", "open"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
    }
    const cli = await runCli({ browser: true, path: `${bin}${delimiter}` });
    try {
      let page = "";
      for (let i = 0; i < 50 && !page; i++) {
        await new Promise((ok) => setTimeout(ok, 100));
        page = existsSync(log) ? readFileSync(log, "utf8").trim() : "";
      }
      assert.ok(existsSync(page), "the opener page exists while the form waits");
      const done = new Promise((ok) => cli.proc.once("exit", (code, signal) => ok({ code, signal })));
      cli.proc.kill(sig);
      assert.deepEqual(await done, { code: null, signal: sig });
      assert.equal(existsSync(dirname(page)), false);
    } finally {
      cli.proc.kill();
      rmSync(bin, { recursive: true, force: true });
    }
  });
}
