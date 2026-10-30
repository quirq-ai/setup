// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCodeowners, policyCards, rulesetState } from "../cli/policies.mjs";
import { parseToml } from "../cli/toml.mjs";

test("parseToml reads the subset quirq-ai's settings files use", () => {
  const t = parseToml(`# header
[org]
owner = "quirq-ai"   # trailing

[main]
required_approvals = 0
bypass = []
url = 'https://x#y'

[[repo]]
name = "xo-space"
kinds = ["python-service",
         "pytest"]          # a list over two lines
[repo.deploy]
target = "vercel"
[[repo.other]]
file = "a # not a comment"

[[repo]]
name = "gate"
checks = ["presubmit"]
size = 1_000
on = true
`);
  assert.deepEqual(t, {
    org: { owner: "quirq-ai" },
    main: { required_approvals: 0, bypass: [], url: "https://x#y" },
    repo: [
      { name: "xo-space", kinds: ["python-service", "pytest"], deploy: { target: "vercel" }, other: [{ file: "a # not a comment" }] },
      { name: "gate", checks: ["presubmit"], size: 1000, on: true },
    ],
  });
});

test("parseToml refuses what it does not read, rather than reading half", () => {
  for (const bad of ['a = { b = 1 }', 'a = """x"""', 'a."b" = 1', "[t]\n[t]", "a = 1\na = 2", "a = [1, 2", "a = 1979-05-27"]) {
    assert.throws(() => parseToml(bad), /line \d+/, bad);
  }
});

const GATE = parseToml(`
[main]
ruleset = "qq-main"
required_approvals = 0

[[repo]]
name = "web"
kind = "product"
allow_auto_merge = true
required_approvals = 1
transitional_checks = ["tests"]

[[repo]]
name = "tools"
kind = "infra"
allow_auto_merge = true
checks = ["presubmit"]
code_owner_review = true
state_branches = ["results"]
`);
const REPOS = parseToml(`
[[repo]]
name = "web"
kinds = ["node-app"]
channels = ["canary"]
[repo.deploy]
target = "vercel"

[[repo]]
name = "cli"
kinds = ["python-package"]
channels = []
`);
const PIPELINES = parseToml(`
[[builder]]
name = "web-presubmit"
repo = "web"
pipeline = "presubmit"
triggers = ["change", "queue"]
blocking = true
generate = true

[[builder]]
name = "web-postsubmit"
repo = "web"
pipeline = "postsubmit"
triggers = ["land"]
generate = true
`);

test("policyCards joins gate settings, repos.toml and pipelines.toml per repo", () => {
  const cards = policyCards(GATE, REPOS, PIPELINES);
  assert.deepEqual(cards.map((c) => [c.name, c.kind]), [["web", "product"], ["cli", "unlisted"], ["tools", "infra"]]);
  const [web, cli, tools] = cards;
  assert.deepEqual(web.merge, { approvals: 1, autoMerge: true, codeOwnerReview: false, checks: ["web-presubmit", "tests"],
    checksFrom: "pipelines", extra: [] });
  assert.deepEqual(web.pipelines.map((p) => p.name), ["web-presubmit", "web-postsubmit"]);
  assert.equal(web.deploy, "vercel");
  assert.deepEqual(web.channels, ["canary"]);
  // Registered in infra-config, not behind the gate: no merge rules, and the card says why.
  assert.equal(cli.merge, null);
  assert.equal(cli.gated, false);
  assert.match(cli.notes[0], /not behind the gate yet/);
  assert.deepEqual(tools.merge, { approvals: 0, autoMerge: true, codeOwnerReview: true, checks: ["presubmit"],
    checksFrom: "settings", extra: ["state branches: results"] });
});

test("rulesetState never reads an unreadable list as missing", () => {
  assert.deepEqual(rulesetState([{ name: "qq-main", enforcement: "active" }], "qq-main"), { ruleset: "applied" });
  assert.deepEqual(rulesetState([{ name: "other" }], "qq-main"), { ruleset: "missing" });
  assert.equal(rulesetState([{ name: "qq-main", enforcement: "disabled" }], "qq-main").ruleset, "missing");
  const r = rulesetState(new Error("HTTP 403"), "qq-main");
  assert.equal(r.ruleset, "unknown");
  assert.match(String(r.rulesetNote), /HTTP 403/);
});

test("parseCodeowners keeps rules in order and drops comments", () => {
  assert.deepEqual(parseCodeowners("# owners\n* @a\n/.github/ @a @b  # infra\n\n"), [
    { pattern: "*", owners: ["@a"] },
    { pattern: "/.github/", owners: ["@a", "@b"] },
  ]);
});
