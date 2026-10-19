#!/usr/bin/env node
// qq-setup's entry. It is written so that an old Node can still read it (Node 10, and 12.17 and up,
// which covers Ubuntu 20.04's and 22.04's own packages), and says plainly that it needs Node 22
// instead of failing on newer syntax in the rest of qq-setup. Keep it that way: no static imports,
// nothing newer than ES2019 plus import(). CI's old-node job runs it on a real Node 12.

var major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error("qq-setup needs Node 22 or newer, and this is Node " + process.versions.node + ".");
  console.error("Install Node 22 or newer, then run the same command again.");
  process.exitCode = 1;
} else {
  // No catch: if the rest fails to load, Node prints its file and line, and exits 1.
  import("./main.mjs");
}
