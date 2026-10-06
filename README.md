# qq-setup

One command to set up quirq infra (qq) for your GitHub org: the terminal checks your tools, a short
form in your browser asks which org and repos, and the terminal shows what it will do.

```sh
npx github:quirq-ai/setup#<commit>
```

Always run it pinned to a full commit id from `main` (the `#<commit>` part): without one, npx runs
whatever the default branch holds at that moment, with your GitHub login. The guide that links to
this command names the commit.

**This version only reads.** It shows the plan and stops: it creates no repo, opens no pull request
and changes no setting. The version that carries the plan out comes next, after review.

## What it does

1. **Checks** Node 22+ (CI tests 22 and 24; qq's own toolchain is Node 24), `git`, `gh` (logged in with the `repo` and `read:org` scopes, which
   `gh auth login` grants) and Python 3.11+ (the setup step will run infra-config's generator and
   gate). It notes that the setup step will also need the `workflow` scope, and how to remove it
   afterwards. It never asks for `admin:org`, `delete_repo` or `gist`. It refuses to run while
   `GH_TOKEN` or `GITHUB_TOKEN` is set, so it only ever acts as your own `gh` login.
2. **Opens a form** on `127.0.0.1` (link printed in the terminal; `--no-browser` only prints it).
   You pick an org you own, the repos to put under qq and, optionally, a new starter repo.
   A repo is offered only when it can run its qq kind's commands as they are: Python service
   (`requirements.txt`), pytest (`requirements-dev.txt` listing pytest), Next.js app (pnpm with
   `build` and `typecheck` scripts) or Gatsby site (pnpm with `build` and `test` scripts). Others
   are listed with the reason, including private repos: GitHub offers a merge queue on private repos
   only on Enterprise Cloud, so v0 sets up public repos only.
3. **Prints the plan** in the terminal: the config repo it would create, each pull request, each
   ruleset, and what qq does not do for other orgs yet (watching `main`, lkgr, the canary,
   dependency rolls, private repos).

**Over SSH:** run it with `--no-browser --port N` and forward the same port number,
`ssh -L N:127.0.0.1:N <host>`; then open the printed link on your own machine. The form answers only
requests addressed to `127.0.0.1:N`, so a forward to a different local port is refused.

Exit codes, as gate and installer use them: 0 done, 1 not ready or stopped (a failed check, no
answer from the form), 2 error.

The full plan for v0, v1 and v2 is in the project thread; this README changes with each step.

## How it keeps your login safe

- Every GitHub call is `gh api --method GET`. qq-setup never reads, stores or prints your token:
  `gh` makes the request itself.
- The form server listens on `127.0.0.1` only, answers only requests whose `Host` is exactly that
  address (no DNS rebinding), and answers `/api/*` only with the one-time key from the printed link.
  The key is in the link's `#fragment`, which browsers never send to a server.
- The page receives only names the command already read (orgs, repos, kinds), never a token. Its
  answers are checked against those names before the terminal uses them.
- No telemetry. The page loads nothing from the internet (no web fonts, strict CSP).

## On a Mac

It works the same. macOS ships Python 3.9, so the later setup step needs a newer one
(`brew install python@3.14`). After setup, `qq build` and `qq test` stay Linux-only, as qq's
toolchains are; CI runs on GitHub's Linux runners.

## Develop

```sh
npm ci
npm run lint
npm run typecheck
npm test            # node:test, tests/*.test.mjs
npm run check-form  # rebuilds the form and fails if out/ differs from what is committed
npm run e2e         # Playwright: the real CLI against tests/fake-gh, 390 and 1280 px, light and dark
```

npx installs straight from this repo and runs no install scripts (npm 12 skips them for git
sources anyway), so the built form is committed in `out/` and the package has no runtime
dependencies. After changing `app/`, `components/` or `lib/`, run `npm run build` and commit `out/`;
CI fails if it is stale. Publishing to npm is a later step that suraj decides.

Layout: `cli/` is the command (plain ES modules with JSDoc types, no build step), `app/` and
`components/` are the form (Next.js 16 static export, shadcn/ui), `lib/api.ts` is the form's side of
the local API.

## License

Apache-2.0. `components/ui/` is from shadcn/ui (MIT); see `components/ui/LICENSE`.
