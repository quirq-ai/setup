// @ts-check
import assert from "node:assert/strict";
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { GhError, ghWrite } from "../cli/gh.mjs";
import { addProduct, editRepo, removeRepo, repin } from "../cli/policy-edit.mjs";
import { applyCommand, checkRequest, childEnv, policyWriter } from "../cli/policy-write.mjs";
import { parseToml } from "../cli/toml.mjs";
import { landOnMain, makeRemotes } from "./fixtures/quirq/remotes.mjs";

const FAKE_PYTHON = new URL("./fake-python/python3", import.meta.url).pathname;

// Shaped like gate's settings/github.toml: comments, sections between the blocks, a release executor.
const SETTINGS = `[main]
ruleset = "qq-main"
required_approvals = 0

[release_refs]
executor_repos = ["release", "web"]

[[org_workflows]]
ruleset = "qq-web-presubmit-pinned"
targets = ["web"]

# --- product repos ---

[[repo]]
name = "web"
allow_auto_merge = true               # agents queue PRs
kind = "product"
required_approvals = 1               # product PRs need one approval
transitional_checks = []

[[repo]]
name = "shop"
allow_auto_merge = false
kind = "product"
required_approvals = 1
transitional_checks = []
dependabot_branches = false

# --- infra repos ---

[[repo]]
name = "gate"
allow_auto_merge = true
kind = "infra"
checks = ["presubmit"]
`;

test("editRepo changes only the named values, in place", () => {
  const out = editRepo(SETTINGS, "web", { approvals: 2, codeOwnerReview: true });
  assert.match(out, /kind = "product"\ncode_owner_review = true\nrequired_approvals = 2\ntransitional_checks/);
  assert.match(out, /allow_auto_merge = true {15}# agents queue PRs/, "an unchanged line keeps its comment");
  assert.equal(out.split("\n").length, SETTINGS.split("\n").length + 1);
  const web = /** @type {any} */ (parseToml(out)).repo[0];
  assert.deepEqual([web.required_approvals, web.code_owner_review], [2, true]);
  // Setting a value to what it is leaves the file as it was, comment and all.
  assert.equal(editRepo(SETTINGS, "web", { approvals: 1 }), SETTINGS);
  assert.throws(() => editRepo(SETTINGS, "nope", { approvals: 1 }), /not listed/);
  assert.throws(() => editRepo(SETTINGS.replace(/\n/g, "\r\n"), "web", { approvals: 1 }), /Windows line endings/);
});

test("addProduct puts one block after the last product, before the next section's comment", () => {
  const out = addProduct(SETTINGS, "newapp", { approvals: 1, autoMerge: true });
  const names = /** @type {any} */ (parseToml(out)).repo.map((/** @type {any} */ r) => r.name);
  assert.deepEqual(names, ["web", "shop", "newapp", "gate"]);
  assert.ok(out.includes('dependabot_branches = false\n\n[[repo]]\nname = "newapp"\nallow_auto_merge = true\nkind = "product"\nrequired_approvals = 1\n'));
  assert.ok(out.includes("dependabot_branches = false           # added with qq-setup; Dependabot rolls are a later, reviewed change\n\n# --- infra repos ---"));
  assert.match(addProduct(SETTINGS, "x", { approvals: 0, autoMerge: false, codeOwnerReview: true }), /code_owner_review = true/);
  assert.throws(() => addProduct(SETTINGS, "shop", { approvals: 1, autoMerge: true }), /already in gate's settings/);
  assert.throws(() => addProduct(SETTINGS, "bad name", { approvals: 1, autoMerge: true }), /not a repo name/);
});

test("removeRepo takes the block out, and refuses a repo gate names elsewhere", () => {
  const out = removeRepo(SETTINGS, "shop");
  assert.deepEqual(/** @type {any} */ (parseToml(out)).repo.map((/** @type {any} */ r) => r.name), ["web", "gate"]);
  assert.ok(out.includes("transitional_checks = []\n\n# --- infra repos ---\n\n[[repo]]\nname = \"gate\""), "the section comment stays");
  assert.throws(() => removeRepo(SETTINGS, "web"), /executor_repos and \[\[org_workflows\]\] qq-web-presubmit-pinned/);
});

test("repin moves only the infra-config commit", () => {
  const pins = '[infra-config]\nsource = "x"\ncommit = "' + "a".repeat(40) + '"   # old\n\n[sync]\ncommit = "' + "b".repeat(40) + '"\n';
  const out = repin(pins, "c".repeat(40), "web added with qq-setup");
  assert.equal(out, pins.replace(`"${"a".repeat(40)}"   # old`, `"${"c".repeat(40)}"   # web added with qq-setup`));
  assert.throws(() => repin(pins, "main", "x"), /not a commit id/);
  assert.throws(() => repin(pins, "c".repeat(40), "a # b"), /one line/);
});

test("checkRequest takes only what each op needs", () => {
  assert.deepEqual(checkRequest({ op: "edit", repo: "web", fields: { approvals: 2 } }),
    { op: "edit", repo: "web", fields: { approvals: 2 }, kinds: [], description: "" });
  for (const [body, why] of /** @type {[unknown, RegExp][]} */ ([
    [{ op: "merge", repo: "web" }, /op must be/],
    [{ op: "edit", repo: "../x", fields: { approvals: 1 } }, /not a repo name/],
    [{ op: "edit", repo: "web", fields: {} }, /nothing to change/],
    [{ op: "edit", repo: "web", fields: { approvals: 11 } }, /0 to 10/],
    [{ op: "edit", repo: "web", fields: { admin: true } }, /unknown field admin/],
    [{ op: "add", repo: "x", fields: { approvals: 1, autoMerge: true } }, /at least one kind/],
    [{ op: "add", repo: "x", fields: { approvals: 1 }, kinds: ["node-app"], description: "x" }, /approvals and auto-merge/],
    [{ op: "add", repo: "x", fields: { approvals: 1, autoMerge: true }, kinds: ["node-app"], description: " " }, /one-line description/],
    [{ op: "add", repo: "x", fields: { approvals: 1, autoMerge: true }, kinds: ["node-app"], description: "two\nlines" }, /one line/],
    [{ op: "remove", repo: "web", fields: { approvals: 1 } }, /only the repo/],
    [{ op: "remove", repo: "web", branch: "main" }, /unknown field branch/],
  ])) assert.throws(() => checkRequest(body), why);
});

test("ghWrite refuses anything but a pull request's pieces in quirq-ai, before gh runs", async () => {
  for (const [path, body, why] of /** @type {[string, Record<string, unknown>, RegExp][]} */ ([
    ["repos/quirq-ai/gate/git/refs/heads/main", { sha: "x" }, /refusing to write/],
    ["repos/quirq-ai/gate/pulls/3/merge", {}, /refusing to write/],
    ["repos/quirq-ai/gate/rulesets", {}, /refusing to write/],
    ["repos/other-org/gate/pulls", { head: "qq-setup/x" }, /refusing to write/],
    ["repos/quirq-ai/../x/pulls", { head: "qq-setup/x" }, /refusing to write/],
    ["repos/quirq-ai/gate/git/refs", { ref: "refs/heads/main", sha: "x" }, /outside qq-setup/],
    ["repos/quirq-ai/gate/git/refs", { ref: "refs/tags/v1", sha: "x" }, /outside qq-setup/],
    ["repos/quirq-ai/gate/pulls", { head: "main", base: "release" }, /outside qq-setup/],
  ])) await assert.rejects(ghWrite(path, body), why);
});

test("the tools' environment has no token and an empty home", () => {
  const env = childEnv("/scratch/home", { PATH: "/bin", GH_TOKEN: "t", GITHUB_TOKEN: "t", SSH_AUTH_SOCK: "/s", HTTPS_PROXY: "http://p", LC_ALL: "C", HOME: "/root" });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.deepEqual([env.PATH, env.HTTPS_PROXY, env.LC_ALL, env.HOME, env.GIT_TERMINAL_PROMPT], ["/bin", "http://p", "C", "/scratch/home", "0"]);
});

/** A writer over local stand-in repos, with GitHub's reads and writes recorded. */
function writer(base, { heads = {}, prs = [], branch = null, now = () => new Date() } =
  /** @type {{ heads?: Record<string, string>, prs?: any[], branch?: any, now?: () => Date }} */ ({})) {
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const writes = [];
  const w = policyWriter({
    base, python: FAKE_PYTHON, now,
    getJson: async (path) => {
      log.push(path);
      if (path.endsWith("/pulls?state=open&per_page=100")) return prs;
      if (path === "repos/quirq-ai/web") return { default_branch: "main", private: false };
      if (path === "repos/quirq-ai/secret") return { default_branch: "main", private: true };
      if (path === "repos/quirq-ai/old") return { default_branch: "master", private: false };
      const head = /^repos\/quirq-ai\/([^/]+)\/git\/ref\/heads\/main$/.exec(path);
      if (head) return { object: { sha: heads[head[1]] } };
      if (path.includes("/git/ref/heads/qq-setup/")) {
        if (branch) return { object: { sha: "made1" } };
        throw new GhError("Not Found", 404);
      }
      if (path.endsWith("/git/commits/made1")) return branch;
      if (path.includes("/git/commits/")) return { tree: { sha: "tree0" } };
      if (path === "repos/quirq-ai/web/rulesets?per_page=100") return [{ id: 11, name: "qq-main" }, { id: 12, name: "release-freeze" }];
      throw new GhError("Not Found", 404);
    },
    ghWrite: async (path, body) => {
      writes.push({ path, body });
      return path.endsWith("/pulls") ? { html_url: "https://github.com/quirq-ai/gate/pull/9" } : { sha: `sha-${writes.length}` };
    },
  });
  return { w, log, writes };
}

const head = (base, name) => readFileSync(join(base, name, ".git", "refs", "heads", "main"), "utf8").trim();

test("edit: one gate pull request with the settings change and the golden plan, opened only on Open", async () => {
  const base = makeRemotes();
  const { w, writes } = writer(base, { heads: { gate: head(base, "gate") } });
  try {
    const plan = /** @type {any} */ (await w.plan({ op: "edit", repo: "web", fields: { approvals: 2 } }));
    assert.equal(plan.ok, true, plan.error);
    assert.deepEqual(plan.steps.map((/** @type {any} */ s) => [s.key, s.state]), [["gate", "ready"], ["apply", "waiting"]]);
    const gate = plan.steps[0];
    assert.deepEqual(gate.files, ["settings/github.toml", "tests/golden/quirq-settings-plan.json"]);
    assert.match(gate.diff, /-required_approvals = 1\n\+required_approvals = 2/);
    assert.equal(writes.length, 0, "planning writes nothing");

    const opened = /** @type {any} */ (await w.open({ id: plan.id, step: "gate" }));
    assert.deepEqual(opened, { ok: true, url: "https://github.com/quirq-ai/gate/pull/9" });
    assert.deepEqual(writes.map((x) => x.path), ["repos/quirq-ai/gate/git/trees", "repos/quirq-ai/gate/git/commits", "repos/quirq-ai/gate/git/refs", "repos/quirq-ai/gate/pulls"]);
    const [tree, commit, ref, pr] = writes.map((x) => x.body);
    assert.equal(tree.base_tree, "tree0");
    assert.deepEqual(tree.tree.map((/** @type {any} */ t) => t.path), gate.files);
    assert.match(tree.tree[0].content, /required_approvals = 2/);
    assert.deepEqual(commit.parents, [head(base, "gate")]);
    assert.match(ref.ref, /^refs\/heads\/qq-setup\/edit-web-[0-9a-f]{7}$/);
    assert.deepEqual([pr.base, pr.head], ["main", ref.ref.replace("refs/heads/", "")]);
    assert.deepEqual(await w.open({ id: plan.id, step: "gate" }), { ok: false, error: "that step has nothing to open" });

    // After the merge, planning again says so and gives the apply command for gate main.
    const merged = landOnMain(base, "gate", (d) => {
      for (const t of tree.tree) writeFileSync(join(d, t.path), t.content);
    });
    const again = /** @type {any} */ (await w.plan({ op: "edit", repo: "web", fields: { approvals: 2 } }));
    assert.deepEqual(again.steps.map((/** @type {any} */ s) => s.state), ["done", "manual"]);
    assert.equal(again.steps[1].command, applyCommand(merged));
  } finally {
    await w.close();
  }
});

test("edit: refused when main moved since the plan, or a pull request is already open", async () => {
  const base = makeRemotes();
  const { w, writes } = writer(base, { heads: { gate: "f".repeat(40) } });
  try {
    const plan = /** @type {any} */ (await w.plan({ op: "edit", repo: "web", fields: { autoMerge: false } }));
    assert.deepEqual(await w.open({ id: plan.id, step: "gate" }), { ok: false, error: "gate's main moved since the plan: plan again" });
    assert.equal(writes.length, 0);
    assert.deepEqual(await w.open({ id: "nope", step: "gate" }), { ok: false, error: "that plan is gone (they last 30 minutes): plan again" });
  } finally {
    await w.close();
  }
  const open = writer(base, { prs: [{ head: { ref: "qq-setup/edit-web-1234567", repo: { full_name: "quirq-ai/gate" } }, html_url: "https://github.com/quirq-ai/gate/pull/5" }] });
  try {
    const plan = /** @type {any} */ (await open.w.plan({ op: "edit", repo: "web", fields: { autoMerge: false } }));
    assert.deepEqual([plan.steps[0].state, plan.steps[0].url], ["open", "https://github.com/quirq-ai/gate/pull/5"]);
  } finally {
    await open.w.close();
  }
});

test("add: infra-config first; the repo's workflows and gate wait for it to merge", async () => {
  const base = makeRemotes();
  const { w, log } = writer(base);
  const add = { op: "add", repo: "web2", fields: { approvals: 1, autoMerge: true }, kinds: ["node-app"], description: "A shop" };
  try {
    assert.deepEqual(await w.plan(add), { ok: false, error: "quirq-ai/web2 is not there, or not visible to your gh login: create it (with a first commit, such as a README), then plan again" });
    assert.deepEqual(await w.plan({ ...add, repo: "secret" }),
      { ok: false, error: "secret is private: v0 adds public repos only (a merge queue on a private repo needs GitHub Enterprise Cloud)" });
    // web is in gate's settings already: every step is done but its workflows, which the fixture lacks.
    const plan = /** @type {any} */ (await w.plan({ ...add, repo: "web" }));
    assert.deepEqual(plan.steps.map((/** @type {any} */ s) => [s.key, s.state]), [["infra-config", "done"], ["repo", "ready"], ["gate", "done"], ["apply", "manual"]]);
    assert.deepEqual(plan.steps[1].files, [".github/workflows/qq-web-presubmit.yml"]);
    assert.match(plan.steps[1].notes[0], /has no infra\/repo.toml/);
    assert.ok(log.includes("repos/quirq-ai/web/pulls?state=open&per_page=100"));
  } finally {
    await w.close();
  }
});

test("add a new product: the gate step moves the pin once infra-config lists it", async () => {
  const base = makeRemotes();
  // newapp is a repo with a first commit; the fake GitHub answers for it.
  cpSync(join(base, "web"), join(base, "newapp"), { recursive: true });
  const add = { op: "add", repo: "newapp", fields: { approvals: 1, autoMerge: true }, kinds: ["node-app"], description: "A new app" };
  const w2 = policyWriter({ base, python: FAKE_PYTHON, getJson: async (p) => {
    if (p === "repos/quirq-ai/newapp") return { default_branch: "main" };
    if (p.endsWith("/pulls?state=open&per_page=100")) return [];
    throw new Error(`unexpected GET ${p}`);
  }, ghWrite: async () => ({}) });
  try {
    const first = /** @type {any} */ (await w2.plan(add));
    assert.deepEqual(first.steps.map((/** @type {any} */ s) => [s.key, s.state]), [["infra-config", "ready"], ["repo", "waiting"], ["gate", "waiting"], ["apply", "waiting"]]);
    assert.deepEqual(first.steps[0].files, ["config/pipelines.toml", "config/repos.toml"]);
    // infra-config's pull request merges.
    const ic = landOnMain(base, "infra-config", (d) => {
      appendFileSync(join(d, "config", "repos.toml"), '\n[[repo]]\nname = "newapp"\nkinds = ["node-app"]\nchannels = []\n');
    });
    const next = /** @type {any} */ (await w2.plan(add));
    assert.deepEqual(next.steps.map((/** @type {any} */ s) => [s.key, s.state]), [["infra-config", "done"], ["repo", "ready"], ["gate", "ready"], ["apply", "waiting"]]);
    const gate = next.steps[2];
    assert.deepEqual(gate.files, ["pins.toml", "settings/github.toml", "tests/golden/quirq-settings-plan.json"]);
    assert.match(gate.diff, new RegExp(`\\+commit = "${ic}"   # newapp added with qq-setup`));
    assert.match(gate.diff, /\+name = "newapp"/);
    assert.match(gate.notes[0], /Moves gate's infra-config pin from [0-9a-f]{7} to [0-9a-f]{7}/);
  } finally {
    await w2.close();
  }
});

test("remove: infra-config, then gate; it says what stays and lists the rulesets", async () => {
  const base = makeRemotes();
  const { w } = writer(base);
  try {
    const plan = /** @type {any} */ (await w.plan({ op: "remove", repo: "web" }));
    assert.equal(plan.ok, true, plan.error);
    assert.deepEqual(plan.steps.map((/** @type {any} */ s) => [s.key, s.state]), [["infra-config", "ready"], ["gate", "waiting"], ["rulesets", "manual"]]);
    assert.match(plan.steps[2].detail, /qq-main ruleset \(and any other qq- ruleset\) stays live/);
    assert.match(plan.steps[2].detail, /qq-\*\.yml workflows stay in the repo/);
    assert.equal(plan.steps[2].command, "gh api --method DELETE repos/quirq-ai/web/rulesets/11   # qq-main");
    assert.deepEqual(await w.plan({ op: "remove", repo: "gate" }),
      { ok: false, error: "gate is one of qq's own infra repos (infra-config org.toml); qq-setup takes product repos out only" });
  } finally {
    await w.close();
  }
});

test("a tool's refusal is shown on its step, and nothing is opened", async () => {
  const base = makeRemotes();
  const { w } = writer(base);
  landOnMain(base, "infra-config", (d) => writeFileSync(join(d, "fake-python-fail"), "remove-repo\n"));
  try {
    const plan = /** @type {any} */ (await w.plan({ op: "remove", repo: "web" }));
    assert.deepEqual([plan.steps[0].state, plan.steps[0].detail], ["refused", "python failed: qqcfg remove-repo: web is named in another area"]);
    assert.deepEqual(await w.open({ id: plan.id, step: "infra-config" }), { ok: false, error: "that step has nothing to open" });
  } finally {
    await w.close();
  }
});

test("open picks up a branch an earlier Open made, and refuses an old plan or someone else's branch", async () => {
  const base = makeRemotes();
  const gate = head(base, "gate");
  const edit = { op: "edit", repo: "web", fields: { approvals: 3 } };
  const resumed = writer(base, { heads: { gate }, branch: { parents: [{ sha: gate }], message: "web: change merge rules (qq-setup)" } });
  try {
    const plan = /** @type {any} */ (await resumed.w.plan(edit));
    assert.deepEqual(await resumed.w.open({ id: plan.id, step: "gate" }), { ok: true, url: "https://github.com/quirq-ai/gate/pull/9" });
    assert.deepEqual(resumed.writes.map((x) => x.path), ["repos/quirq-ai/gate/pulls"], "only the pull request: the branch is there");
  } finally {
    await resumed.w.close();
  }
  const other = writer(base, { heads: { gate }, branch: { parents: [{ sha: "e".repeat(40) }], message: "something else" } });
  try {
    const plan = /** @type {any} */ (await other.w.plan(edit));
    assert.match(/** @type {any} */ (await other.w.open({ id: plan.id, step: "gate" })).error, /already has a branch qq-setup\/edit-web-[0-9a-f]{7} with no open pull request/);
    assert.equal(other.writes.length, 0);
  } finally {
    await other.w.close();
  }
  let t = Date.parse("2026-10-30T12:00:00Z");
  const late = writer(base, { heads: { gate }, now: () => new Date(t) });
  try {
    const plan = /** @type {any} */ (await late.w.plan(edit));
    t += 31 * 60 * 1000;
    assert.deepEqual(await late.w.open({ id: plan.id, step: "gate" }), { ok: false, error: "that plan is gone (they last 30 minutes): plan again" });
    assert.equal(late.writes.length, 0);
  } finally {
    await late.w.close();
  }
});

test("a pull request for another repo whose name starts the same is not this one's", async () => {
  const base = makeRemotes();
  const { w } = writer(base, { prs: [{ head: { ref: "qq-setup/edit-web-app-1234567", repo: { full_name: "quirq-ai/gate" } }, html_url: "https://github.com/quirq-ai/gate/pull/5" }] });
  try {
    const plan = /** @type {any} */ (await w.plan({ op: "edit", repo: "web", fields: { approvals: 2 } }));
    assert.equal(plan.steps[0].state, "ready");
    assert.match(/** @type {any} */ (await w.plan({ op: "add", repo: "old", fields: { approvals: 1, autoMerge: true }, kinds: ["node-app"], description: "Old" })).error,
      /old's default branch is master: qq-setup adds repos whose default branch is main/);
  } finally {
    await w.close();
  }
});
