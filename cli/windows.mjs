// @ts-check
// What qq-setup says on Windows, where its install steps (sh commands for Linux and macOS) cannot run.
// A common trap: in WSL with no Linux Node, the shell finds Windows' npx, because WSL adds Windows' PATH
// by default, so qq-setup runs on Windows' Node. Its folder then reads \\wsl.localhost\<distro>\... (or
// \\wsl$\... on older WSL), or C:\... when started under /mnt/c.
// Windows' Node folder has node.exe but no file named node, and WSL's shell does not add .exe, so in WSL
// `which node` prints nothing there; `which npx` finds Windows' npx (a sh script), under /mnt/c.

/** Whether Windows' Node was started from a WSL folder. @param {string} cwd */
export function fromWsl(cwd) {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(cwd);
}

const CHECK = "check that `which npx` prints a path that does not start with /mnt/c";

/** The one explanation, for the page, `install` and the terminal note. @param {string} cwd */
export function windowsNote(cwd) {
  return fromWsl(cwd)
    ? "This is a WSL terminal, but it ran Windows' Node, which WSL found on Windows' PATH. qq-setup's install steps " +
        "are shell commands for Linux and macOS, so they cannot run on Windows' Node. Install Node 22 or newer inside WSL, " +
        `open a new WSL terminal, ${CHECK}, then run the same command again. qq-setup is not tested in WSL.`
    : "qq-setup's install steps are shell commands for Linux and macOS, and qq runs on Linux and macOS. " +
        "To try them on this PC, use WSL, which gives Windows a Linux terminal: install Node 22 or newer inside WSL, " +
        "then run the same command there. qq-setup is not tested in WSL. If you already ran it in WSL, it ran Windows' Node: " +
        `install Node 22 or newer inside WSL, open a new WSL terminal, ${CHECK}, then run it again.`;
}
