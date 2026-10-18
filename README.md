# qq-setup

One command to install, update or remove qq and xo on your machine, to put qq on your machine and
work on a repo that already uses it, or to set up quirq infra (qq) for your GitHub org: the terminal
checks your tools and opens a short form in your browser where you pick what to do.

```sh
npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/<commit>
```

`<commit>` is the full id of the latest commit on
[`main`](https://github.com/quirq-ai/setup/commits/main). Always pin it: the link then serves
exactly that commit, and nothing that lands on `main` later. npx downloads it as a tarball, not
through git: npm 10's npx cannot run a `github:` link pinned to a commit ("GitFetcher requires an
Arborist constructor"). `--allow-remote=root` lets npm run a package from a tarball link. npm 12
refuses one without it. npm 11.14 and later honour the flag, though by default they already allow
tarball links. npm 10 and npm 11.0 to 11.13 ignore it. Either way it is harmless here, because the package has no
dependencies.

**The form changes nothing on GitHub.** For your org it shows the plan and stops: it creates no
repo, opens no pull request and changes no setting. The version that carries the plan out comes
next, after review. On your own machine, its first choice installs, updates or removes qq and xo:
it shows the exact commands for what you pick and runs them when you press Run. The same is in the
terminal as [`install`](#install-update-or-remove-qq-and-xo).

## What it does

1. **Checks** Node 22+ (CI tests 22 and 24; qq's own toolchain is Node 24), `git`, `gh` (logged in with the `repo` and `read:org` scopes, which
   `gh auth login` grants) and Python 3.11.4+ (`QQ_PYTHON` if set, else `python3`: qq runs that one, and the setup step will
   run infra-config's generator and gate). It notes that the setup step will also need the `workflow` scope, and how to remove it
   afterwards. It never asks for `admin:org`, `delete_repo` or `gist`. It refuses to run while
   `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` is set, so it
   only ever acts as your own `gh` login. Without `git`, `gh` or a `gh` login the form still opens,
   for this machine only.
2. **Opens a form** on `127.0.0.1` (link printed in the terminal; `--no-browser` only prints it).
   It asks what you want to do:
   - **Install, update or remove qq and xo on this machine** (the first choice). It shows what is
     installed, as [`install`](#install-update-or-remove-qq-and-xo) does, and a choice per tool. Each
     starts at Keep (or Don't install), so nothing is installed or removed until you pick it. It
     shows the exact commands for what you picked, and Run runs them here, as you, with their
     output on the page and in the terminal. Removing qq offers its demo folders and its
     `QQ_PYTHON` line as unticked boxes. "Done: close qq-setup" stops the command.
   - **Install qq on my machine and work on a repo.** The terminal prints the commands from the
     [qq guide](https://docs.quirq.dev/docs/install) that install `qq` and `qqsync` and put them on your
     `PATH` (on a Mac, its Python step first), then `qq fetch https://github.com/<owner>/<name>` for the repo you name (`git clone` on a Mac),
     and what `qq sync`, `qq build`, `qq test` and `qq run` do (on a Mac, `qq build`, `qq test` and
     `qq run`, with the caveat under "On a Mac"). It runs none of them. To push
     branches to the repo, an owner gives you Write access. A login that owns no org starts here.
   - **Set up repos in an org I own** (steps 3 and 4). You pick an org you own, the repos to put under qq and, optionally, a new starter repo.
   A repo is offered only when it can run its qq kind's commands as they are: Python service
   (`requirements.txt`), pytest (`requirements-dev.txt` listing pytest, and tests at the root), Next.js app (pnpm with
   `build` and `typecheck` scripts) or Gatsby site (pnpm with `build` and `test` scripts). Others
   are listed with the reason, including private repos: GitHub offers a merge queue on private repos
   only on Enterprise Cloud, so v0 sets up public repos only.
3. **Reads what already guards each picked repo** (merge settings, rulesets and branch
   protection, all with GETs) and prints a warning for anything that would get in qq's way, or
   "no existing protection found".
4. **Prints the plan** in the terminal: the config repo it would create, each pull request, each
   ruleset, what qq does not do for other orgs yet (watching `main`, lkgr, the canary, dependency
   rolls, private repos, `qq land`), that on GitHub Free the gate is honour-based, and how to undo
   setup.

**Over SSH:** run it with `--no-browser --port N` and forward the same port number,
`ssh -L N:127.0.0.1:N <host>`; then open the printed link on your own machine. The form answers only
requests addressed to `127.0.0.1:N`, so a forward to a different local port is refused.

Exit codes, as gate and installer use them: 0 done, 1 not ready or stopped (a failed check, or no
request from the form for 30 minutes), 2 error. Ctrl-C stops it by signal, which shells report as
130.

## Install, update or remove qq and xo

```sh
npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/<commit> install
```

It looks at what is already on this machine and says so: qq's commit in `~/qq-tools/depot` and the newest
one on GitHub, qqsync's commit, xo's commit in `~/.xo`, and whether each is on your `PATH`. Then it asks,
for each tool: install it if it is missing (or reinstall it if it is there but broken); update, remove or
keep it if it is there. It prints the exact commands, runs them after you say yes, and stops at the first
one that fails (each is safe to run again). It never writes to GitHub and needs no `gh` login. It changes
files only in your home directory, except that on a Mac with no new enough Python its first step is
`brew install python@3.13`, which writes to Homebrew's folder. While you are removing a tool, Enter
at "Install xo?" installs nothing.

- **qq** (with qqsync) installs with the [qq guide](https://docs.quirq.dev/docs/install)'s three commands.
  Updating reruns them, which deletes and re-clones `~/qq-tools/depot`, so qq is kept when the checkout
  has local work, unless you choose otherwise; `--yes` always keeps it. Local work is what git can
  show: files `git status` lists (changed, staged or untracked, but not ones git is told to ignore), commits
  no remote branch has (on any branch or tag, on a detached HEAD, or only in a reflog, as after a
  reset), stashes, and other worktrees. When git cannot check, qq is kept too. When only the `PATH`
  line is missing, it adds just that line. Removing deletes `~/qq-tools`, `~/.cache/qq` and the
  `PATH` line, as the guide's "Remove everything" does. That command also deletes the guide's demo
  folders, `~/qq-try` and `~/qq-ci-venv`, where your own clones may be: this asks about each by name,
  and `--yes` keeps them. It asks too before deleting an `export QQ_PYTHON=python3.N` line (something
  else may use that Python; `--yes` keeps it), and it leaves one written another way, or a `PATH`
  line written another way, and says so.
- **xo** installs at the commit the [xo quickstart](https://github.com/quirq-ai/xo/blob/main/docs/quickstart.md)
  pins, and updates with its `pip install --force-reinstall --no-deps` at that commit. An xo at another
  commit is reported, not called out of date, since the XO team may have given you a newer one; updating
  it would move it back to the pin. When only its `PATH` line is missing, it adds just that line. Only
  a venv (with `pyvenv.cfg`) at `~/.xo` counts as xo's; any other `~/.xo` is left alone, and xo is not
  installed over it. Removing runs `xo logout` (which deletes the saved XO key and asks before logging
  gh out), or, when xo cannot run, deletes that key itself, then `~/.xo` and its `PATH` line. After an
  install, run `xo login` with your XO API key.
- **Python.** qq needs 3.11.4 or newer and xo 3.11: `QQ_PYTHON` if set, else `python3`, else the newest
  `python3.N` it finds. For qq, that name is then written to your startup file as `QQ_PYTHON`, so qq
  finds it later. On a Mac with none, the first step is `brew install python@3.13`, then (for qq)
  `export QQ_PYTHON=python3.13` goes into the same startup file as qq's `PATH` line. That differs
  from the qq guide's Python line, which always writes `~/.zshrc`, so a bash user's next terminal
  would have qq on `PATH` but no `QQ_PYTHON`. It checks for `git` first.
- `--only qq` or `--only xo` picks one; `--update` or `--remove` answers for every tool; `--yes` asks
  nothing (without a terminal it needs it); `--dry-run` prints the commands and runs nothing.

## How it keeps your login safe

- Every GitHub call is `gh api --method GET`. qq-setup never reads, stores or prints your token:
  `gh` makes the request itself.
- The form server listens on `127.0.0.1` only, answers only requests whose `Host` is exactly that
  address (no DNS rebinding), and answers `/api/*` only to the one tab that used the printed link.
  The link's key is in its `#fragment`, which browsers never send to a server, and works once: the
  tab trades it for an HttpOnly, SameSite=Strict cookie plus a token it keeps in its own
  `sessionStorage`, and drops the key from the address bar. Every later call needs both, so another
  tab, another browser, or another program listening on 127.0.0.1 (browsers send cookies to every
  port there) gets nothing. The terminal says when the link was used, and when someone tries it again.
- When qq-setup opens your browser itself, it passes only the path of a page only you can read (a
  0600 file in a 0700 temporary folder, under `~/snap/<browser>/common` for a snap browser), deleted
  once used, so the key does not appear on a command line other users could see with `ps`. If you
  open the printed link by hand, it briefly can, which is why it works only once. Flatpak browsers,
  or a `.html` file that opens in an editor, need the printed link.
- The page receives only names the command already read (orgs, repos, kinds), your platform name
  and the fixed text of the install path, never a token. Its answers are checked against those
  names before the terminal uses them.
- The "This machine" choice never receives a command from the page. The page sends only a choice
  per tool, which must be one the tool's state offers, with the signature of the look it shows;
  qq-setup plans only while the machine still matches that look (so every warning on the page is
  current), and keeps the plan under a random id. Run sends only that id, runs the latest plan once,
  and first looks at the machine again: if anything changed (local work in qq, a tool added or
  gone, a demo folder or `QQ_PYTHON` line), it refuses and the page shows the new state. Steps run
  with no input from a terminal, one at a time, and stop at the first that fails. Only one run goes
  at a time, and the form cannot be closed under it.
- So the link now does more than read: whoever opens it first can run the steps the page offers,
  including removing qq even with local work, deleting demo folders ticked on the page and logging
  xo out. That is why the key works once, never travels on a command line when qq-setup opens the
  browser, and why the terminal says when the link was used and when someone tries it again: if
  you did not open it, press Ctrl-C.
- No telemetry. The page loads nothing from the internet (no web fonts, strict CSP).

## On a Mac

It works the same. macOS ships Python 3.9, too old for qq, so on a Mac the install commands start
with the qq guide's Python step: `brew install python@3.13`, `export QQ_PYTHON=python3.13` in
`~/.zshrc`, and a new terminal. About toolchains, the form, the terminal and this section say the
same thing:

qq fetches toolchains for Linux x86_64 only, so on a Mac qq fetch clones the repo and then stops with
"no pin for platform", and qq sync stops the same way: clone with git and install the repo's pinned
tools yourself (qqsync show infra/repo.toml lists them). qq build and qq test then use them, from
--toolchain NAME=ROOT or your PATH, and still check the pinned versions (exact Python, Node major);
qq run uses your PATH.

So on a Mac the form and terminal show `git clone` instead of `qq fetch`, leave out
`qq sync`, and list `qq build`, `qq test` and `qq run`. See the
[qq guide](https://docs.quirq.dev/docs/install). The CI workflows qq sets up for a repo run on
GitHub's Linux runners, whatever machine you work on.

## Develop

```sh
npm ci
npm run lint
npm run typecheck
npm test            # node:test, tests/*.test.mjs
npm run check-form  # rebuilds the form and fails if out/ differs from what is committed
npm run e2e         # Playwright: the real CLI against tests/fake-gh, 390 and 1280 px, light and dark
```

npx installs straight from this repo and must run no install scripts, so the built form is committed in `out/` and the package has no runtime
dependencies. After changing `app/`, `components/` or `lib/`, run `npm run build` and commit `out/`;
CI fails if it is stale. Publishing to npm is a later step that suraj decides.

Layout: `cli/` is the command (plain ES modules with JSDoc types, no build step), `app/` and
`components/` are the form (Next.js 16 static export, shadcn/ui), `lib/api.ts` is the form's side of
the local API.

## License

Apache-2.0. `components/ui/` is from shadcn/ui (MIT); see `components/ui/LICENSE`.
