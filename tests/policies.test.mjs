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
  for (const bad of ['a = { b = 1 }', 'a = """x"""', 'a."b" = 1', "[t]\n[t]", "a = 1\na = 2", "a = [1, 2", "a = 1979-05-27",
    "a = [1,,2]", "a = [,1]", "x = 007", "x = 1_", "x = _1", "[a.b]\n[a]\n[a]"]) {
    assert.throws(() => parseToml(bad), /line \d+/, bad);
  }
});

test("parseToml never writes through to Object.prototype", () => {
  for (const bad of ["[__proto__.polluted]\nx = 1", "[a.__proto__]\nx = 1", "__proto__ = 1", "constructor = 1", "[[prototype]]"]) {
    assert.throws(() => parseToml(bad), /unsupported/, bad);
  }
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test("parseToml accepts a parent table after its dotted child, and a trailing comma", () => {
  assert.deepEqual(parseToml("[a.b]\nx = 1\n[a]\ny = 2\nz = [1, 2,]\nn = 1_000"), { a: { b: { x: 1 }, y: 2, z: [1, 2], n: 1000 } });
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
name = "web-integration"
repo = "web"
pipeline = "integration"
triggers = ["change", "queue"]
blocking = true

[[builder]]
name = "web-postsubmit"
repo = "web"
pipeline = "postsubmit"
triggers = ["land"]
generate = true
`);

const ORG = parseToml(`
[[infra_repo]]
name = "tools"

[[infra_repo]]
name = "newtool"
`);

test("policyCards joins gate settings, repos.toml, org.toml and pipelines.toml per repo", () => {
  const cards = policyCards(GATE, REPOS, PIPELINES, ORG);
  assert.deepEqual(cards.map((c) => [c.name, c.kind]), [["web", "product"], ["cli", "unlisted"], ["newtool", "unlisted"], ["tools", "infra"]]);
  const [web, cli, newtool, tools] = cards;
  // Every blocking builder is required, whatever its pipeline, as gate's required.compute has it.
  assert.deepEqual(web.merge, { approvals: 1, autoMerge: true, codeOwnerReview: false, checks: ["web-presubmit", "web-integration", "tests"],
    checksFrom: "pipelines", extra: [] });
  assert.deepEqual(web.pipelines.map((p) => p.name), ["web-presubmit", "web-integration", "web-postsubmit"]);
  assert.equal(web.deploy, "vercel");
  assert.deepEqual(web.channels, ["canary"]);
  // Registered in infra-config, not behind the gate: no merge rules, and the card says why.
  assert.equal(cli.merge, null);
  assert.equal(cli.gated, false);
  assert.match(cli.notes[0], /repos.toml, but not behind the gate yet/);
  // An infra repo org.toml registers and gate does not list.
  assert.match(newtool.notes[0], /org.toml \[\[infra_repo\]\], but not behind the gate yet/);
  // No allow_auto_merge in gate: GitHub keeps its own setting, so it is neither on nor off.
  assert.deepEqual(tools.merge, { approvals: 0, autoMerge: null, codeOwnerReview: true, checks: ["presubmit"],
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
