// @ts-check
// Compare each copied-commands fixture with the file, commit and lines its header names: the qq
// guide (quirq-ai/docs) for qq's install and remove commands, the xo quickstart (quirq-ai/xo) for xo's.
// Needs the network (raw.githubusercontent.com), or local clones that have the commits:
//   node scripts/check-guide.mjs [DOCS_CLONE [XO_CLONE]]
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const FIXTURES = ["qq-guide-install.txt", "qq-guide-remove.txt", "xo-quickstart.txt"];
/** @type {Record<string, string | undefined>} */
const clones = { docs: process.argv[2], xo: process.argv[3] };

let failed = false;
for (const name of FIXTURES) {
  const text = await readFile(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");
  const [head1, head2, ...cmds] = text.replace(/\n$/, "").split("\n");
  const [, repo, file, sha] = /^# .* in quirq-ai\/(docs|xo) (\S+) at ([0-9a-f]{40}),$/.exec(head1) ?? [];
  const lines = [...(/^# lines ([\d, and]+), copied unchanged/.exec(head2)?.[1] ?? "").matchAll(/\d+/g)].map(Number);
  if (!repo || !file || !sha || lines.length !== cmds.length) {
    console.error(`check-guide: ${name}: the header must name a repo, a file, a full commit and one line per command`);
    process.exit(2);
  }
  let doc;
  if (clones[repo]) {
    doc = execFileSync("git", ["-C", /** @type {string} */ (clones[repo]), "show", `${sha}:${file}`], { encoding: "utf8" });
  } else {
    const res = await fetch(`https://raw.githubusercontent.com/quirq-ai/${repo}/${sha}/${file}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.error(`check-guide: ${repo} ${file} at ${sha}: HTTP ${res.status}`);
      process.exit(2);
    }
    doc = await res.text();
  }
  const at = doc.split("\n");
  // A command inside a callout or a continued block is indented two spaces; the fixture keeps it without them.
  const bad = lines.filter((n, i) => (at[n - 1] ?? "").replace(/^ {2}(?=\S)/, "") !== cmds[i]);
  if (bad.length) {
    console.error(`check-guide: ${name}: ${repo} ${file} at ${sha.slice(0, 7)}, line ${bad.join(", ")}: not the fixture's command`);
    failed = true;
  } else {
    console.log(`check-guide: ${name} matches ${repo} ${file} at ${sha.slice(0, 7)}, lines ${lines.join(", ")}`);
  }
}
process.exit(failed ? 1 : 0);
