// @ts-check
// Checks before anything opens: the tools the full setup needs, the user's gh login and its scopes.
// Each failing check says the one thing to do about it.

import { execFile } from "node:child_process";
import { TOKEN_VARS, whoami } from "./gh.mjs";
import { MAC, MAC_PYTHON, qqPython } from "./tools.mjs";
import { windowsNote } from "./windows.mjs";
import { findExe, pickPython, pythonHelp, pythonOk } from "./install.mjs";

/** What this read-only build needs: `gh auth login` grants both (with gist, which setup never uses). */
export const NEEDED_SCOPES = ["repo", "read:org"];
/** What the setup step will need on top: `workflow`, to add files under .github/workflows. gh grants it
 * only when it also sets up git, so it is a note now, not a failure. setup never asks for admin:org,
 * delete_repo or gist. */
export const LATER_SCOPES = ["workflow"];

/** @typedef {{ name: string, ok: boolean, fatal: boolean, detail: string }} Check */

/**
 * Pure: turn what was observed into checks.
 * @param {{ node: string, platform: string, env: Record<string, string | undefined>, cwd?: string,
 *   git: string | null, gh: string | null, python: string | null, pythonCmd: string,
 *   login: string | null, scopes: string[] | null, loginError: string | null, newer?: string | null }} seen
 *   newer: the Python qq-setup's install step would use when this one is too old, as "cmd (version)"
 * @returns {Check[]}
 */
export function checks(seen) {
  /** @type {Check[]} */
  const out = [];
  const [major] = seen.node.replace(/^v/, "").split(".").map(Number);
  out.push({ name: "Node", ok: major >= 22, fatal: true,
    detail: major >= 22 ? seen.node : `${seen.node}; qq-setup needs Node 22 or newer` });

  const setVars = TOKEN_VARS.filter((v) => seen.env[v]);
  out.push({ name: "No token variables", ok: !setVars.length, fatal: true,
    detail: setVars.length
      ? `${setVars.join(" and ")} ${setVars.length > 1 ? "are" : "is"} set; qq-setup uses only your own gh login: run  unset ${setVars.join(" ")}`
      : "qq-setup uses your gh login" });

  out.push({ name: "git", ok: !!seen.git, fatal: true, detail: seen.git ?? "git is not installed" });
  out.push({ name: "gh", ok: !!seen.gh, fatal: true, detail: seen.gh ?? "gh (GitHub CLI) is not installed: https://cli.github.com" });

  // qq's launcher runs QQ_PYTHON, else python3, and refuses anything older than 3.11.4 (qq bin/qq:20-23);
  // the setup step's qqcfg needs 3.11+. Check the one qq will run. When it is too old, qq-setup's install
  // step looks further (python3.14 to python3.11) and sets QQ_PYTHON to what it finds: seen.newer.
  // On Windows, where qq does not run, the one xo's install uses: python, else py, at 3.11 or newer.
  const win = seen.platform === "win32";
  const pyOk = pythonOk(seen.python, win ? [3, 11, 0] : [3, 11, 4]);
  out.push({ name: win ? "Python 3.11+" : "Python 3.11.4+", ok: pyOk, fatal: false,
    detail: `${seen.python ?? "not found"} (${seen.pythonCmd}${seen.env.QQ_PYTHON ? ", from QQ_PYTHON" : ""})` +
      (pyOk ? "" : (win ? "; xo needs Python 3.11 or newer" : "; qq and the setup step need Python 3.11.4 or newer") +
        (seen.newer ? (win ? `. qq-setup found ${seen.newer}: installing xo here uses it` : `. qq-setup found ${seen.newer}: installing or updating qq here sets QQ_PYTHON to it`)
          : seen.platform === "darwin" ? `. macOS's python3 is 3.9: run  ${MAC_PYTHON.cmd}  then open a new terminal`
            : `. ${pythonHelp({ cmd: seen.env.QQ_PYTHON || null, version: seen.python, ok: false, persist: false }, seen.platform)}`)) });

  if (seen.gh && !setVars.length) {
    out.push({ name: "gh login", ok: !!seen.login, fatal: true,
      detail: seen.login ? `logged in as ${seen.login}` : `${seen.loginError ?? "not logged in"}: run  gh auth login` });
    if (seen.login) {
      if (seen.scopes === null) {
        out.push({ name: "gh scopes", ok: true, fatal: false,
          detail: "this login does not list scopes (fine-grained token); GitHub will refuse what it lacks" });
      } else {
        const has = (/** @type {string} */ x) => !!seen.scopes?.includes(x) || (x === "read:org" && !!seen.scopes?.includes("admin:org"));
        const missing = NEEDED_SCOPES.filter((x) => !has(x));
        out.push({ name: "gh scopes", ok: !missing.length, fatal: true,
          detail: missing.length ? `missing ${missing.join(", ")}: run  gh auth refresh -h github.com -s ${missing.join(",")}`
            : seen.scopes.join(", ") });
        const later = LATER_SCOPES.filter((x) => !has(x));
        if (later.length) {
          out.push({ name: "Scope for the setup step", ok: false, fatal: false,
            detail: `not needed for this version; the setup step will also need ${later.join(", ")} (gh auth refresh -h github.com -s ${later.join(",")}); ` +
              `to drop it afterwards: gh auth refresh -h github.com --remove-scopes ${later.join(",")}` });
        }
      }
    }
  }

  if (seen.platform === "darwin") {
    out.push({ name: "macOS", ok: true, fatal: false,
      detail: `setup works here. ${MAC}` });
  } else if (seen.platform === "win32") {
    out.push({ name: "Windows", ok: false, fatal: false, detail: windowsNote(seen.env, seen.cwd ?? "") });
  }
  return out;
}

/** @param {string} cmd @param {string[]} args @returns {Promise<string | null>} first line of output, or null */
function version(cmd, args) {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return ok(null);
      ok((String(stdout).trim() || String(stderr).trim()).split("\n")[0] || null);
    });
  });
}

/** Observe the machine and the login, then check. @returns {Promise<Check[]>} */
export async function preflight() {
  // On Windows, python (xo's venv is made with it there; qq does not run on Windows).
  const pythonCmd = process.platform === "win32" ? process.env.QQ_PYTHON || "python" : qqPython(process.env);
  const [git, ghv, python] = await Promise.all([
    version("git", ["--version"]),
    version("gh", ["--version"]),
    // On Windows by full path from PATH's folders, never the current folder's python.exe.
    process.platform === "win32" ? (async () => { const at = /[\\/]/.test(pythonCmd) ? pythonCmd : findExe(pythonCmd.replace(/\.exe$/i, ""), process.env);
      return at ? version(at, ["--version"]) : null; })() : version(pythonCmd, ["--version"]),
  ]);
  let login = null, scopes = null, loginError = null;
  if (ghv && !TOKEN_VARS.some((v) => process.env[v])) {
    try {
      ({ login, scopes } = await whoami());
    } catch (e) {
      loginError = e instanceof Error ? e.message : String(e);
      if (/gh auth login|GH_TOKEN/.test(loginError)) loginError = "not logged in"; // the detail adds the fix
    }
  }
  // What the install step would use instead, as it picks it (never past a QQ_PYTHON).
  const floor = process.platform === "win32" ? [3, 11, 0] : [3, 11, 4];
  const newer = !process.env.QQ_PYTHON && !pythonOk(python, floor) ? await pickPython(process.env, floor) : null;
  return checks({ node: process.version, platform: process.platform, env: process.env, cwd: process.cwd(),
    git, gh: ghv, python, pythonCmd, login, scopes, loginError, newer: newer?.ok ? `${newer.cmd} (${newer.version})` : null });
}
