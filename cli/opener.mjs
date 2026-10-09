// @ts-check
// Opening the browser without putting the key on a command line. Any local user can read another
// process's argv (ps), and a browser started fresh keeps its URL there for its whole life. So the
// opener gets the path of a page only this user can read, and that page sends the browser on to the
// link. The key is single-use anyway (cli/server.mjs); this keeps it out of argv while it is live.

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write the redirect page: in a new directory only this user can enter (mkdtemp makes it 0700), as a
 * file only this user can read (0600), created fresh (never through an existing file or link).
 * @param {string} url  the form's link, with the key in its fragment
 * @returns {Promise<{ path: string, remove: () => void }>}  remove is synchronous, so it also runs on exit
 */
export async function writeOpener(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#key=[A-Za-z0-9_-]+$/.test(url)) throw new Error("not a qq-setup link");
  const dir = await mkdtemp(join(tmpdir(), "qq-setup-"));
  const path = join(dir, "open.html");
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>qq-setup</title>
<script>location.replace(${JSON.stringify(url)});</script>
<p><a href="${url}">Continue to qq-setup</a></p>
`;
  await writeFile(path, html, { mode: 0o600, flag: "wx" });
  let removed = false;
  return {
    path,
    remove: () => {
      if (removed) return;
      removed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Open a local file with the platform's opener; never through a shell. @param {string} path */
export function openFile(path) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [path]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", path]]
    : ["xdg-open", [path]];
  execFile(cmd, args, { timeout: 10_000 }, () => {}); // failure is fine: the link is printed
}
