// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromWsl, windowsNote } from "../cli/windows.mjs";

test("windows: Windows' Node started from a WSL folder is told apart from a plain Windows folder", () => {
  for (const cwd of ["\\\\wsl.localhost\\Ubuntu\\home\\surshar", "\\\\wsl$\\Ubuntu-22.04\\home\\a", "\\\\WSL.LOCALHOST\\Debian\\"]) {
    assert.ok(fromWsl(cwd), cwd);
  }
  for (const cwd of ["C:\\Users\\a", "\\\\server\\share\\wsl.localhost", "/home/a", "\\\\wslx\\a", ""]) {
    assert.ok(!fromWsl(cwd), cwd);
  }
});

test("windows: in WSL the note says it ran Windows' Node and how to check, never to go and use WSL", () => {
  const note = windowsNote("\\\\wsl.localhost\\Ubuntu\\home\\surshar");
  assert.match(note, /^This is a WSL terminal, but it ran Windows' Node/);
  assert.match(note, /Install Node 22 or newer inside WSL, open a new WSL terminal, check that `which node` prints a path that does not start with \/mnt\/c/);
  assert.doesNotMatch(note, /To try them on this PC, use WSL/);
});

test("windows: from a Windows folder the note points to WSL and covers having already started there", () => {
  const note = windowsNote("C:\\Users\\a");
  assert.match(note, /To try them on this PC, use WSL/);
  assert.match(note, /If you already ran it in WSL, it ran Windows' Node/);
});
