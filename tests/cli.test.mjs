// @ts-check
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { detectKinds } from "../cli/detect.mjs";
import { encodeRef, ghEnv, isName } from "../cli/gh.mjs";
import { buildPlan, checkAnswers } from "../cli/plan.mjs";
import { checks } from "../cli/preflight.mjs";
import { startServer } from "../cli/server.mjs";

test("detectKinds offers a kind only when kinds.toml's stand-in commands will run", () => {
  const next = { dependencies: { next: "16.3.8" }, scripts: { build: "next build", typecheck: "tsc --noEmit" } };
  assert.deepEqual(detectKinds(["requirements.txt", "requirements-dev.txt"], { requirementsDev: "pytest==8.4\nruff\n" }).kinds,
    ["python-service", "pytest"]);
  assert.deepEqual(detectKinds(["package.json", "pnpm-lock.yaml"], { packageJson: next }).kinds, ["node-app"]);
  assert.deepEqual(detectKinds(["package.json", "pnpm-lock.yaml"],
    { packageJson: { dependencies: { gatsby: "4" }, scripts: { build: "gatsby build", test: "node --test" } } }).kinds, ["gatsby-site"]);

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
  for (const bad of ["", "../x", "a/b", "-x", "x.git", "a b", "a?b", 3]) assert.ok(!isName(bad), String(bad));
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
  assert.match(plan.does[0], /^Create acme\/qq-config/);
  assert.match(text, /Create acme\/new \(public\) from the Next\.js 16 app/);
  assert.match(text, /acme\/api \(python-service, pytest\): add infra\/repo\.toml/);
  assert.match(text, /acme\/web \(node-app\): keep its infra\/repo\.toml, add the generated/);
  for (const r of ["api", "web", "new"]) assert.match(text, new RegExp(`Protect acme/${r}'s default branch`));
  assert.match(plan.later.join("\n"), /canary/);
  assert.match(buildPlan({ org: "acme", repos: ["api"], starter: null }, repos, true).does[0], /^Update acme\/qq-config/);
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
  assert.match(dflt.find((c) => c.name === "Scope for the setup step")?.detail ?? "", /--remove-scopes workflow/);
  for (const c of checks(base)) assert.doesNotMatch(c.detail, /admin:org|delete_repo|-s gist/);

  const mac = checks({ ...base, platform: "darwin", python: "Python 3.9.6" });
  assert.match(mac.find((c) => c.name === "Python 3.11+")?.detail ?? "", /brew install python@3\.14/);
  assert.equal(mac.find((c) => c.name === "Python 3.11+")?.fatal, false);
  assert.match(mac.find((c) => c.name === "macOS")?.detail ?? "", /Linux only/);

  assert.equal(checks({ ...base, node: "v20.11.0" })[0].ok, false);
  assert.equal(checks({ ...base, login: null, loginError: "not logged in" }).find((c) => c.name === "gh login")?.ok, false);
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

test("server: key, host, origin, body size and static files", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-setup-test-"));
  await mkdir(join(root, "out"));
  await writeFile(join(root, "out", "index.html"), "<p>form</p>");
  await writeFile(join(root, "secret.txt"), "outside");
  /** @type {unknown[]} */
  const submitted = [];
  const srv = await startServer({
    root: join(root, "out"),
    handlers: {
      state: async () => ({ hello: "world" }),
      repos: async (org) => ({ org }),
      submit: async (b) => (submitted.push(b), { ok: true }),
    },
  });
  try {
    const p = srv.port;
    const k = { "x-qq-setup-key": srv.key };
    assert.ok(srv.url.startsWith(`http://127.0.0.1:${p}/#key=`));

    const page = await hit(p, { path: "/" });
    assert.equal(page.status, 200);
    assert.equal(page.body, "<p>form</p>");
    assert.match(String(page.headers["content-security-policy"]), /connect-src 'self'/);

    assert.equal((await hit(p, { path: "/api/state" })).status, 403);
    assert.equal((await hit(p, { path: "/api/state", headers: { "x-qq-setup-key": "wrong" } })).status, 403);
    assert.equal((await hit(p, { path: "/api/state", headers: k })).body, JSON.stringify({ hello: "world" }));
    assert.equal((await hit(p, { path: "/api/state", headers: k, host: `localhost:${p}` })).status, 421);
    assert.equal((await hit(p, { path: "/api/state", headers: { ...k, origin: "http://evil.example" } })).status, 403);

    assert.equal((await hit(p, { path: "/../secret.txt" })).status, 404);
    assert.equal((await hit(p, { path: "/%2e%2e/secret.txt" })).status, 404);
    assert.equal((await hit(p, { method: "POST", path: "/" })).status, 405);

    const post = (/** @type {string} */ body, /** @type {Record<string, string>} */ h = {}) =>
      hit(p, { method: "POST", path: "/api/answers", headers: { ...k, "content-type": "application/json", ...h }, body });
    assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post(JSON.stringify({ pad: "x".repeat(20_000) }))).status, 413);
    assert.equal((await post(JSON.stringify({ org: "acme" }))).status, 200);
    assert.deepEqual(submitted, [{ org: "acme" }]);
  } finally {
    srv.close();
  }
});
