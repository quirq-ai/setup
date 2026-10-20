// @ts-check
// What qq-setup says on Windows, where its install steps (sh commands for Linux and macOS) cannot run.
// A common trap: in WSL with no Linux Node, the shell finds Windows' npx, because WSL adds Windows' PATH
// by default, so qq-setup runs on Windows' Node. npx then starts in \\wsl.localhost\<distro>\... (or
// \\wsl$\... on older WSL), or in C:\... when started under /mnt/c.
// qq-setup's own folder does not show it: on Windows, npx runs a package through cmd.exe in the folder npx
// started in (npm/cli lib/commands/exec.js, libnpmexec's scriptShell), and cmd.exe cannot stay in a
// \\wsl... folder, so it moves to C:\Windows. npm keeps the folder npx started in as INIT_CWD
// (@npmcli/config set-envs.js). qq-setup's own folder still counts, for a Node started without npx.
// Windows' Node folder has node.exe but no file named node, and WSL's shell does not add .exe, so in WSL
// `which node` prints nothing there; `which npx` finds Windows' npx (a sh script), under /mnt/.

/** Whether a Windows folder is in WSL. @param {string | undefined} folder */
export function fromWsl(folder) {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(folder ?? "");
}

// No backticks: pasted into bash, `which npx` runs whatever which prints.
const CHECK = "check that the command  which npx  prints a path that does not start with /mnt/";

/**
 * The one explanation, for the page, `install` and the terminal note.
 * @param {Record<string, string | undefined>} env  INIT_CWD: the folder npx started in
 * @param {string} cwd  qq-setup's own folder
 */
export function windowsNote(env, cwd) {
  return fromWsl(env.INIT_CWD) || fromWsl(cwd)
    ? "This is a WSL terminal, but it ran Windows' Node, which WSL found on Windows' PATH. qq-setup's install steps " +
        "are shell commands for Linux and macOS, so they cannot run on Windows' Node. Install Node 22 or newer inside WSL, " +
        `open a new WSL terminal, ${CHECK}, then run qq-setup's command again. qq-setup is not tested in WSL.`
    : "qq-setup's install steps are shell commands for Linux and macOS, and qq runs on Linux and macOS. " +
        "To try them on this PC, use WSL, which gives Windows a Linux terminal: install Node 22 or newer inside WSL, " +
        "then run the same command there. qq-setup is not tested in WSL. If you already ran it in WSL, it ran Windows' Node: " +
        `install Node 22 or newer inside WSL, open a new WSL terminal, ${CHECK}, then run qq-setup's command again.`;
}
