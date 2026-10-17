// @ts-check
// Compare tests/fixtures/qq-guide-install.txt with the docs file, commit and lines its header names.
// Needs the network (raw.githubusercontent.com), or a local clone of quirq-ai/docs that has the commit:
//   node scripts/check-guide.mjs [DOCS_CLONE]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const text = await readFile(new URL("../tests/fixtures/qq-guide-install.txt", import.meta.url), "utf8");
const [head1, head2, ...cmds] = text.replace(/\n$/, "").split("\n");
const [, file, sha] = /^# .* in quirq-ai\/docs (\S+) at ([0-9a-f]{40}),$/.exec(head1) ?? [];
const lines = [...(/^# lines ([\d, and]+), copied unchanged/.exec(head2)?.[1] ?? "").matchAll(/\d+/g)].map(Number);
if (!file || !sha || lines.length !== cmds.length) {
  console.error("check-guide: the fixture's header must name a file, a full commit and one line per command");
  process.exit(2);
}
let doc;
if (process.argv[2]) {
  doc = execFileSync("git", ["-C", process.argv[2], "show", `${sha}:${file}`], { encoding: "utf8" });
} else {
  const res = await fetch(`https://raw.githubusercontent.com/quirq-ai/docs/${sha}/${file}`);
  if (!res.ok) {
    console.error(`check-guide: ${file} at ${sha}: HTTP ${res.status}`);
    process.exit(2);
  }
  doc = await res.text();
}
const at = doc.split("\n");
// A command inside a callout is indented two spaces in the MDX; the fixture keeps it without them.
const bad = lines.filter((n, i) => (at[n - 1] ?? "").replace(/^ {2}(?=\S)/, "") !== cmds[i]);
if (bad.length) {
  console.error(`check-guide: ${file} at ${sha.slice(0, 7)}, line ${bad.join(", ")}: not the fixture's command`);
  process.exit(1);
}
console.log(`check-guide: the fixture matches ${file} at ${sha.slice(0, 7)}, lines ${lines.join(", ")}`);
