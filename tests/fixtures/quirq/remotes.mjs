// @ts-check
// Local stand-ins for quirq-ai's repos, made from the folders next to this file: one git repo each,
// with main as the only branch, served to `git fetch` by path (QQ_SETUP_GIT_BASE). gate's pins.toml
// names infra-config's first commit, as the real one names a reviewed commit.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
/** @param {string} dir @param {string[]} a */
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], {
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
}).trim();

/** @param {string} dir @param {string} name @param {(d: string) => void} [edit] */
function repo(dir, name, edit) {
  const d = join(dir, name);
  cpSync(join(HERE, name), d, { recursive: true });
  edit?.(d);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", `${name} fixture`);
  return git(d, "rev-parse", "HEAD");
}

/** Make the repos; returns the folder to use as QQ_SETUP_GIT_BASE. */
export function makeRemotes(base = mkdtempSync(join(tmpdir(), "qq-setup-remotes-"))) {
  const ic = repo(base, "infra-config");
  repo(base, "gate", (d) => {
    const p = join(d, "pins.toml");
    writeFileSync(p, readFileSync(p, "utf8").replace("@INFRA_CONFIG@", ic));
  });
  repo(base, "web");
  return base;
}

/** Commit a change to a stand-in's main, as a merged pull request would. @param {string} base @param {string} name @param {(d: string) => void} edit */
export function landOnMain(base, name, edit) {
  const d = join(base, name);
  edit(d);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "landed");
  return git(d, "rev-parse", "HEAD");
}
