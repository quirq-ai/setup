// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromWsl, windowsNote } from "../cli/windows.mjs";
import { checks } from "../cli/preflight.mjs";

const WSL = "\\\\wsl.localhost\\Ubuntu\\home\\surshar";

test("windows: Windows' Node started from a WSL folder is told apart from a plain Windows folder", () => {
  for (const cwd of [WSL, "\\\\wsl$\\Ubuntu-22.04\\home\\a", "\\\\WSL.LOCALHOST\\Debian\\", "\\\\WSL$\\Debian\\"]) {
    assert.ok(fromWsl(cwd), cwd);
  }
  for (const cwd of ["C:\\Users\\a", "C:\\Windows", "\\\\server\\share\\wsl.localhost", "/home/a", "\\\\wslx\\a",
    "\\\\wsl.localhost.example.com\\share", "\\\\wsl$x\\a", "", undefined]) {
    assert.ok(!fromWsl(cwd), String(cwd));
  }
});

test("windows: npx's folder counts, since npx runs qq-setup through cmd.exe, which moves to C:\\Windows", () => {
  // What suraj hit: npx started in WSL's home, cmd.exe moved to C:\Windows, npm kept INIT_CWD.
  const npx = windowsNote({ INIT_CWD: WSL }, "C:\\Windows");
  assert.match(npx, /^This is a WSL terminal, but it ran Windows' Node/);
  assert.doesNotMatch(npx, /To try them on this PC, use WSL/);
  // Node started without npx (or cmd.exe told to keep \\wsl... folders): its own folder.
  assert.match(windowsNote({}, WSL), /^This is a WSL terminal/);
  // Started under /mnt/c, or on Windows itself: nothing shows WSL.
  assert.match(windowsNote({ INIT_CWD: "C:\\Users\\a" }, "C:\\Windows"), /To try them on this PC, use WSL/);
});

test("windows: in WSL the note says how to check npx, never to go and use WSL, and nothing to paste with backticks", () => {
  const note = windowsNote({ INIT_CWD: WSL }, "C:\\Windows");
  assert.match(note, /Install Node 22 or newer inside WSL, open a new WSL terminal, check that the command {2}which npx {2}prints a path that does not start with \/mnt\/ \(if it prints nothing, Node is not installed inside WSL yet\), then run qq-setup's command again\./);
  assert.doesNotMatch(note, /which node/);
  for (const n of [note, windowsNote({}, "C:\\Users\\a")]) assert.doesNotMatch(n, /`/);
});

test("windows: from a Windows folder the note points to WSL and covers having already started there", () => {
  const note = windowsNote({}, "C:\\Users\\a");
  assert.match(note, /To try them on this PC, use WSL/);
  assert.match(note, /If you already ran it in WSL, it ran Windows' Node: .*which npx/);
  // Sent to WSL from here, which npx prints nothing at first: the note says what that means.
  assert.match(note, /which npx {2}prints a path that does not start with \/mnt\/ \(if it prints nothing, Node is not installed inside WSL yet\), then run qq-setup's command again\.$/);
});

test("windows: the terminal's Windows line uses what preflight saw, not this test's own folder", () => {
  const base = { node: "v24.1.0", platform: "win32", git: "git version 2.50", gh: "gh version 2.89",
    python: "Python 3.14.8", pythonCmd: "python", login: "sam", scopes: ["repo", "workflow", "read:org"], loginError: null };
  const line = (/** @type {Record<string, string>} */ env, /** @type {string} */ cwd) =>
    checks({ ...base, env, cwd }).find((c) => c.name === "Windows")?.detail ?? "";
  assert.match(line({ INIT_CWD: WSL }, "C:\\Windows"), /^qq-setup installs qq and xo on Linux and macOS only\. This is a WSL terminal/);
  assert.match(line({}, WSL), /This is a WSL terminal/);
  assert.match(line({}, "C:\\Users\\a"), /To try them on this PC, use WSL/);
});
