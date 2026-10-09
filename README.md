# qq-setup

One command to set up quirq infra (qq) for your GitHub org, or to put qq on your machine and work on
a repo that already uses it: the terminal checks your tools, a short form in your browser asks
which, and the terminal shows what it will do or prints the commands.

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

**This version only reads.** It shows the plan or prints commands and stops: it creates no repo,
opens no pull request, changes no setting and installs nothing. The version that carries the plan out comes next, after review.

## What it does

1. **Checks** Node 22+ (CI tests 22 and 24; qq's own toolchain is Node 24), `git`, `gh` (logged in with the `repo` and `read:org` scopes, which
   `gh auth login` grants) and Python 3.11+ (the setup step will run infra-config's generator and
   gate). It notes that the setup step will also need the `workflow` scope, and how to remove it
   afterwards. It never asks for `admin:org`, `delete_repo` or `gist`. It refuses to run while
   `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` is set, so it
   only ever acts as your own `gh` login.
2. **Opens a form** on `127.0.0.1` (link printed in the terminal; `--no-browser` only prints it).
   It asks what you want to do:
   - **Install qq on my machine and work on a repo.** The terminal prints the three commands from the
     [qq guide](https://docs.quirq.dev/docs/qq) that install `qq` and `qqsync` and put them on your
     `PATH`, then `qq fetch https://github.com/<owner>/<name>` for the repo you name (`git clone` on a Mac),
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

## How it keeps your login safe

- Every GitHub call is `gh api --method GET`. qq-setup never reads, stores or prints your token:
  `gh` makes the request itself.
- The form server listens on `127.0.0.1` only, answers only requests whose `Host` is exactly that
  address (no DNS rebinding), and answers `/api/*` only to the one page that used the printed link.
  The link's key is in its `#fragment`, which browsers never send to a server, and works once: the
  page trades it for an HttpOnly, SameSite=Strict cookie and drops it from the address bar, so a
  second browser or tab with the same link gets nothing. The browser is opened through a page only
  you can read (a 0600 file in a 0700 temporary folder, deleted once used), so the key never appears
  on a command line that other users of the machine could see with `ps`.
- The page receives only names the command already read (orgs, repos, kinds), your platform name
  and the fixed text of the install path, never a token. Its answers are checked against those
  names before the terminal uses them.
- No telemetry. The page loads nothing from the internet (no web fonts, strict CSP).

## On a Mac

It works the same. macOS ships Python 3.9, so the later setup step needs a newer one
(`brew install python@3.14`), as does installing qq. The form, the terminal and this section say the
same thing:

qq fetches toolchains for Linux x86_64 only, so on a Mac qq fetch clones the repo and then stops with
"no pin for platform", and qq sync stops the same way: clone with git and install the repo's pinned
tools yourself (qqsync show infra/repo.toml lists them). qq build and qq test then use them, from
--toolchain NAME=ROOT or your PATH, and still check the pinned versions (exact Python, Node major);
qq run uses your PATH.

So on a Mac the form and terminal show `git clone` instead of `qq fetch`, leave out
`qq sync`, and list `qq build`, `qq test` and `qq run`. See the
[qq guide](https://docs.quirq.dev/docs/qq). The CI workflows qq sets up for a repo run on
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
