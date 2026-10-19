#!/usr/bin/env node
// qq-setup's entry. It is written so that an old Node (12 and up, as Ubuntu's own package gives) can
// still read it, and says plainly that it needs Node 22 instead of failing on newer syntax in the rest
// of qq-setup. Keep it that way: no static imports, nothing newer than ES2019 plus import().

var major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error("qq-setup needs Node 22 or newer, and this is Node " + process.versions.node + ".");
  console.error("Install Node 22 or newer, then run the same command again.");
  process.exitCode = 1;
} else {
  import("./main.mjs").catch(function (e) {
    console.error("qq-setup: " + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 2;
  });
}
