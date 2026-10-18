import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { SYNC_PIN, XO_PIN } from "../../cli/install.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "test-results", "screenshots");
// The line that gets a repo: qq fetch, or git clone on a Mac, where qq fetch stops after cloning.
const GET = process.platform === "darwin" ? "git clone" : "qq fetch";
const AS_DARWIN = ["--import", pathToFileURL(join(ROOT, "tests", "e2e", "as-darwin.mjs")).href];

type Cli = { proc: ChildProcess; url: string; output: () => string; exited: Promise<number | null> };

/** Start the real CLI with the fake gh first on PATH, no token variables and a scratch HOME (so the
 * "This machine" panel never looks at, or runs anything in, the real one). */
async function startCli(extra: Record<string, string> = {}, nodeArgs: string[] = []): Promise<Cli> {
  const HOME = mkdtempSync(join(tmpdir(), "qq-setup-e2e-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, PATH: `${join(ROOT, "tests", "fake-gh")}:${process.env.PATH}`, NO_COLOR: "1", ...extra };
  for (const v of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[v];
  const proc = spawn(process.execPath, [...nodeArgs, join(ROOT, "cli", "bin.mjs"), "--no-browser"], { env });
  let out = "";
  proc.stdout!.on("data", (c) => (out += c));
  proc.stderr!.on("data", (c) => (out += c));
  const exited = new Promise<number | null>((ok) => proc.on("exit", ok));
  const url = await new Promise<string>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no link from the CLI:\n${out}`)), 15_000);
    proc.stdout!.on("data", () => {
      const m = /http:\/\/127\.0\.0\.1:\d+\/#key=[A-Za-z0-9_-]+/.exec(out);
      if (m) {
        clearTimeout(t);
        ok(m[0]);
      }
    });
  });
  return { proc, url, output: () => out, exited };
}

/** The form opens on "This machine"; the org setup is the third choice. */
async function pickRepos(page: Page) {
  await page.getByRole("radio", { name: "Set up repos in an org I own" }).check();
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`form ${width}px ${scheme}: pick repos and a starter, plan prints in the terminal`, async ({ browser }) => {
      const cli = await startCli();
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 }, colorScheme: scheme });
      try {
        await page.goto(cli.url);
        await pickRepos(page);
        // One org is usable, so it is picked for the user; the member-only org is shown disabled.
        await expect(page.getByRole("radio", { name: /acme-labs/ })).toBeChecked();
        await expect(page.getByRole("radio", { name: /big-co/ })).toBeDisabled();
        await expect(page.getByText("you are not an owner of this org")).toBeVisible();

        await page.getByRole("checkbox", { name: /billing-api/ }).check();
        await page.getByRole("checkbox", { name: /^web/ }).check();
        await expect(page.getByText("has infra/repo.toml")).toBeVisible();
        await expect(page.getByText(/qq v0 sets up public repos only/)).toBeVisible();
        await expect(page.getByText(/Next\.js needs pnpm-lock\.yaml/)).toBeVisible();

        await page.getByRole("checkbox", { name: "Create a starter repo" }).check();
        await page.getByLabel("Name").fill("web");
        await expect(page.getByText("acme-labs already has a repo with this name.")).toBeVisible();
        await expect(page.getByRole("button", { name: /Show the plan/ })).toBeDisabled();
        await expect(page.getByText("Fix the starter repo name to continue.")).toBeVisible();
        await page.getByLabel("Name").fill("new-app");
        await expect(page.getByText(/already has a repo/)).toHaveCount(0);

        // No horizontal scroll at phone width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);

        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `form-${width}-${scheme}.png`), fullPage: true });

        await page.getByRole("button", { name: /Show the plan/ }).click();
        await expect(page.getByText("Back to your terminal")).toBeVisible();
        await page.screenshot({ path: join(SHOTS, `done-${width}-${scheme}.png`) });

        expect(await cli.exited).toBe(0);
        const out = cli.output();
        expect(out).toContain("Plan for acme-labs");
        expect(out).toContain("Create acme-labs/new-app (public)");
        expect(out).toContain("Open a pull request in acme-labs/billing-api");
        expect(out).toContain("billing-api: warning: could not read main's branch protection");
        expect(out).not.toContain("billing-api: no existing protection found");
        expect(out).toContain("web: warning: other rulesets apply (release-freeze)");
        expect(out).toContain("web: warning: its required checks (ci/build) must also run on merge_group");
        expect(out).toContain("web: warning: it requires 1 approving review: setup would leave its pull request open for you");
        expect(out).toContain("To undo setup: delete the qq-main and qq-reserved-tags rulesets");
        expect(out).toContain("Nothing was changed.");
      } finally {
        cli.proc.kill();
        await page.close();
      }
    });
  }
}

test("a starter name taken by a repo the form did not list is refused", async ({ browser }) => {
  const cli = await startCli();
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await pickRepos(page);
    await expect(page.getByRole("radio", { name: /acme-labs/ })).toBeChecked();
    await page.getByRole("checkbox", { name: "Create a starter repo" }).check();
    // The form uses the terminal's own name rule (cli/names.mjs), so .git in any case is refused here.
    await page.getByLabel("Name").fill("new-app.Git");
    await expect(page.getByText(/not ending in \.git/)).toBeVisible();
    await page.getByLabel("Name").fill("old-archive-2019");
    await page.getByRole("button", { name: /Show the plan/ }).click();
    await expect(page.getByText("old-archive-2019 already exists in acme-labs")).toBeVisible();
    await page.getByLabel("Name").fill("new-app");
    await page.getByRole("button", { name: /Show the plan/ }).click();
    await expect(page.getByText("Back to your terminal")).toBeVisible();
    expect(await cli.exited).toBe(0);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("the link works once: the key leaves the address bar, and no other tab, browser or port gets in", async ({ browser }) => {
  const cli = await startCli();
  const port = Number(new URL(cli.url).port);
  // Another program listening on 127.0.0.1: browsers send it the form's cookie too.
  let harvested = "";
  const thief = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) harvested = String(req.headers.cookie ?? "");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>other</p>");
  });
  await new Promise<void>((ok) => thief.listen(0, "127.0.0.1", ok));
  const thiefPort = (thief.address() as AddressInfo).port;
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const page = await first.newPage();
    await page.goto(cli.url);
    await pickRepos(page);
    await expect(page.getByRole("radio", { name: /acme-labs/ })).toBeChecked();
    expect(page.url()).not.toContain("key=");
    const cookies = await first.cookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });
    // A reload keeps working on this tab's session.
    await page.reload();
    await pickRepos(page);
    await expect(page.getByRole("radio", { name: /acme-labs/ })).toBeChecked();

    // Another tab in the same browser has the cookie but not the tab's token.
    const tab = await first.newPage();
    await tab.goto(cli.url);
    await expect(tab.getByText("Open this page from your terminal")).toBeVisible();
    await expect(tab.getByText("acme-labs")).toHaveCount(0);

    // A page on another port receives the cookie, and the cookie alone opens nothing.
    const other = await first.newPage();
    await other.goto(`http://127.0.0.1:${thiefPort}/`);
    await other.evaluate(() => fetch("/api/x").then((r) => r.text()));
    expect(harvested).toMatch(new RegExp(`qq_setup_${port}=`));
    for (const header of ["1", ""]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { cookie: harvested, ...(header ? { "x-qq-setup": header } : {}) },
      });
      expect(res.status).toBe(header ? 401 : 403);
      expect(await res.text()).not.toContain("acme-labs");
    }
    // Control: that same cookie with the first tab's token does work, so the 401 above is the token's.
    const token = await page.evaluate(() => sessionStorage.getItem("qq-setup-token"));
    const ok = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie: harvested, "x-qq-setup": String(token) } });
    expect(ok.status).toBe(200);

    // Another browser with the same link gets nothing either.
    const stranger = await second.newPage();
    await stranger.goto(cli.url);
    await expect(stranger.getByText("Open this page from your terminal")).toBeVisible();
    await expect(stranger.getByText("acme-labs")).toHaveCount(0);
    expect(cli.output()).toMatch(/The form was opened in a browser/);
    expect(cli.output()).toMatch(/Someone tried the link again; it was refused\./);
  } finally {
    cli.proc.kill();
    thief.close();
    await first.close();
    await second.close();
  }
});

test("a browser that does not keep the cookie is told so, not sent back to the terminal", async ({ browser }) => {
  const cli = await startCli();
  const page = await browser.newPage();
  try {
    // Stand in for a browser that refuses cookies on 127.0.0.1: the trade succeeds, but the next call
    // arrives without the cookie, which the server answers with 401.
    await page.route("**/api/state", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "no cookie" }) }),
    );
    await page.goto(cli.url);
    await expect(page.getByText(/did not keep qq-setup.s cookie.*Allow cookies for 127\.0\.0\.1/)).toBeVisible();
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("a page without the key gets nothing from the API", async ({ browser }) => {
  const cli = await startCli();
  const page = await browser.newPage();
  try {
    const bare = cli.url.replace(/#.*/, "");
    await page.goto(bare);
    await expect(page.getByText("Open this page from your terminal")).toBeVisible();
    await expect(page.getByText("npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/<commit>")).toBeVisible();
    const res = await page.request.get(`${bare}api/state`);
    expect(res.status()).toBe(403);
    expect(await res.text()).not.toContain("acme-labs");
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`tools ${width}px ${scheme}: the install and fetch commands print in the terminal`, async ({ browser }) => {
      const cli = await startCli();
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 }, colorScheme: scheme });
      try {
        await page.goto(cli.url);
        await page.getByRole("radio", { name: "Install qq on my machine and work on a repo" }).check();
        await expect(page.getByRole("radio", { name: /acme-labs/ })).toHaveCount(0);
        await expect(page.getByText("1. Install qq on this machine")).toBeVisible();
        await expect(page.getByText(/git clone -q https:\/\/github\.com\/quirq-ai\/qq /)).toBeVisible();
        for (const notARepo of [".git", "https://github.com/"]) {
          await page.getByLabel("Repo (optional)").fill(notARepo);
          await expect(page.getByText("Write it as owner/name, like quirq-ai/innernet.")).toBeVisible();
        }
        await page.getByLabel("Repo (optional)").fill("innernet");
        await expect(page.getByText("Write it as owner/name, like quirq-ai/innernet.")).toBeVisible();
        await expect(page.getByRole("button", { name: /Print these/ })).toBeDisabled();
        // A pasted link with .git is taken as the owner/name it names.
        await page.getByLabel("Repo (optional)").fill("https://github.com/quirq-ai/innernet.git");
        await expect(page.getByText(`${GET} https://github.com/quirq-ai/innernet`, { exact: true })).toBeVisible();
        await expect(page.getByText("Write it as owner/name", { exact: false })).toHaveCount(0);
        // Commands never wrap, so no word is split: each block scrolls on its own, the page does not.
        for (const pre of await page.locator("pre").all()) {
          expect(await pre.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre");
          expect(await pre.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
        }

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `tools-${width}-${scheme}.png`), fullPage: true });

        await page.getByRole("button", { name: /Print these/ }).click();
        await expect(page.getByText("qq-setup printed the commands there.", { exact: false })).toBeVisible();
        expect(await cli.exited).toBe(0);
        const out = cli.output();
        expect(out).toContain("Install qq on this machine. Run each command once:");
        expect(out).toContain(`${GET} https://github.com/quirq-ai/innernet`);
        expect(out).toContain("Nothing was installed.");
        expect(out).not.toContain("Plan for");
      } finally {
        cli.proc.kill();
        await page.close();
      }
    });
  }
}

test("a login that owns no org gets this machine and the install commands, not the org setup", async ({ browser }) => {
  const cli = await startCli({ FAKE_GH_NO_ORGS: "1" });
  const page = await browser.newPage();
  try {
    expect(cli.output()).toContain("owns no GitHub org, so the form can only install qq and xo here");
    await page.goto(cli.url);
    await expect(page.getByRole("radio", { name: "Install, update or remove qq and xo on this machine" })).toBeChecked();
    await expect(page.getByText(/You own no GitHub org yet/)).toBeVisible();
    await expect(page.getByRole("radio", { name: "Set up repos in an org I own" })).toBeDisabled();
    await page.getByRole("radio", { name: "Install qq on my machine and work on a repo" }).check();
    await page.getByRole("button", { name: /Print these/ }).click();
    expect(await cli.exited).toBe(0);
    expect(cli.output()).toContain(`${GET} https://github.com/OWNER/NAME`);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("each command has a copy button that copies it exactly", async ({ browser }) => {
  const cli = await startCli();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  try {
    await page.goto(cli.url);
    await page.getByRole("radio", { name: "Install qq on my machine and work on a repo" }).check();
    const getRepo = process.platform === "darwin" ? "Copy: Clone the repo" : "Copy: Get the repo";
    for (const name of ["Copy: Install qq", "Copy: Install qqsync", "Copy: Put both on your PATH", getRepo]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(1);
    }
    await page.getByRole("button", { name: "Copy: Install qq", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied: Install qq" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await page.locator("pre").first().innerText());
    expect(copied).toMatch(/^\( set -e; mkdir -p ~\/qq-tools; rm -rf ~\/qq-tools\/depot; git clone -q /);
  } finally {
    cli.proc.kill();
    await context.close();
  }
});

test("on a Mac: git clone, the note beside it, and no qq sync", async ({ browser }) => {
  const cli = await startCli({}, AS_DARWIN);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    expect(cli.output()).toContain("macOS: setup works here.");
    await page.goto(cli.url);
    await page.getByRole("radio", { name: "Install qq on my machine and work on a repo" }).check();
    // A tab is not blank: the page refuses it, as the terminal does.
    await page.getByLabel("Repo (optional)").fill("\t");
    await expect(page.getByText("Write it as owner/name, like quirq-ai/innernet.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Print these/ })).toBeDisabled();
    await page.getByLabel("Repo (optional)").fill("quirq-ai/innernet");
    // A Mac's python3 is 3.9: the qq guide's Python step comes before the install commands.
    await expect(page.locator("pre").first()).toHaveText(
      "brew install python@3.13 && { grep -qs 'QQ_PYTHON=' ~/.zshrc || echo 'export QQ_PYTHON=python3.13' >> ~/.zshrc; }");
    await expect(page.getByText("git clone https://github.com/quirq-ai/innernet", { exact: true })).toBeVisible();
    await expect(page.getByText(/stops with "no pin for platform".*--toolchain NAME=ROOT/)).toBeVisible();
    await expect(page.getByText(/^qq fetch https/)).toHaveCount(0);
    await expect(page.getByText("qq sync", { exact: true })).toHaveCount(0);
    for (const cmd of ["qq build [TARGET]", "qq test [TARGET]", 'qq run "COMMAND"']) {
      await expect(page.getByText(cmd, { exact: true })).toHaveCount(1);
    }
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "tools-390-mac.png"), fullPage: true });
    await page.getByRole("button", { name: /Print these/ }).click();
    expect(await cli.exited).toBe(0);
    const out = cli.output();
    expect(out).toContain("     git clone https://github.com/quirq-ai/innernet\n");
    expect(out).not.toMatch(/qq fetch https|^ +qq sync/m);
    expect(out).toMatch(/Inside it:\n +qq build/);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

/** A HOME with xo installed as its quickstart leaves it (a venv whose xo and pip answer), and its PATH line. */
function homeWithXo(logout = 'echo "fake xo: logged out"'): string {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-e2e-xo-"));
  mkdirSync(join(home, ".xo", "bin"), { recursive: true });
  writeFileSync(join(home, ".xo", "pyvenv.cfg"), "home = /usr/bin\n");
  writeFileSync(join(home, ".xo", "bin", "xo"), `#!/bin/sh\ncase "$1" in --version) echo "xo 0.1.0" ;; logout) ${logout} ;; esac\n`, { mode: 0o755 });
  writeFileSync(join(home, ".xo", "bin", "pip"), `#!/bin/sh\necho "quirq-xo @ git+https://github.com/quirq-ai/xo@${XO_PIN}"\n`, { mode: 0o755 });
  writeFileSync(join(home, ".zshrc"), '\nexport PATH="$HOME/.xo/bin:$PATH"\n');
  return home;
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`this machine ${width}px ${scheme}: nothing is picked at first; Remove xo runs its steps here`, async ({ browser }) => {
      const home = homeWithXo();
      const cli = await startCli({ HOME: home, SHELL: "/bin/zsh" });
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 }, colorScheme: scheme });
      try {
        await page.goto(cli.url);
        await expect(page.getByRole("radio", { name: "Install, update or remove qq and xo on this machine" })).toBeChecked();
        // Each tool starts at Keep (or Don't install), so Run has nothing to run.
        const qq = page.getByRole("radiogroup", { name: "What to do with qq" });
        const xo = page.getByRole("radiogroup", { name: "What to do with xo" });
        await expect(qq.getByRole("radio", { name: "Don't install" })).toBeChecked();
        await expect(xo.getByRole("radio", { name: "Keep" })).toBeChecked();
        await expect(page.getByText("Nothing to do with these choices.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();

        await xo.getByRole("radio", { name: "Remove" }).check();
        await expect(page.getByText("1. Log xo out", { exact: false })).toBeVisible();
        await expect(page.getByText("rm -rf ~/.xo", { exact: true })).toBeVisible();
        await expect(page.getByText(/xo logout keeps your gh login/)).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `machine-${width}-${scheme}.png`), fullPage: true });

        await page.getByRole("button", { name: "Run these 3 steps" }).click();
        await expect(page.getByRole("heading", { name: "Done" })).toBeVisible();
        await expect(page.getByLabel("Output")).toContainText("fake xo: logged out");
        await expect(page.getByText("(done)")).toHaveCount(3);
        expect(existsSync(join(home, ".xo"))).toBe(false);
        expect(existsSync(join(home, ".zshrc"))).toBe(false); // it held only xo's line
        // A fresh look: xo is now not installed, and the choice is back to Don't install.
        await expect(xo.getByRole("radio", { name: "Don't install" })).toBeChecked();
        await page.screenshot({ path: join(SHOTS, `machine-ran-${width}-${scheme}.png`), fullPage: true });

        await page.getByRole("button", { name: "Done: close qq-setup" }).click();
        await expect(page.getByText("qq-setup has stopped. You can close this tab.")).toBeVisible();
        expect(await cli.exited).toBe(0);
        expect(cli.output()).toContain("Running the steps picked in the form:");
        expect(cli.output()).toContain("fake xo: logged out");
      } finally {
        cli.proc.kill();
        await page.close();
      }
    });
  }
}

test("this machine: a plan made before the machine changed is refused, and the page looks again", async ({ browser }) => {
  const home = homeWithXo();
  const cli = await startCli({ HOME: home, SHELL: "/bin/zsh" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await page.getByRole("radiogroup", { name: "What to do with xo" }).getByRole("radio", { name: "Remove" }).check();
    await expect(page.getByRole("button", { name: "Run these 3 steps" })).toBeEnabled();
    // xo goes away behind the page's back: the plan it shows no longer fits.
    rmSync(join(home, ".xo"), { recursive: true });
    await page.getByRole("button", { name: "Run these 3 steps" }).click();
    await expect(page.getByText(/something changed on this machine since the plan was made/)).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "What to do with xo" }).getByRole("radio", { name: "Don't install" })).toBeChecked();
    expect(cli.output()).not.toContain("Running the steps picked in the form:");
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("this machine: a ~/.xo that is not xo's is left alone, and the form opens without a gh login", async ({ browser }) => {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-e2e-other-"));
  mkdirSync(join(home, ".xo", "config"), { recursive: true });
  const cli = await startCli({ HOME: home, FAKE_GH_NO_LOGIN: "1" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await expect(page.getByText("Move ~/.xo away to install xo here; qq-setup leaves it alone.")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "What to do with xo" })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Set up repos in an org I own" })).toBeDisabled();
    await expect(page.getByText(/Needs GitHub, which is not ready/)).toBeVisible();
    // The page cannot ask for what the state does not offer.
    const seen = (await callApi(page, "/api/machine")).body.seen;
    const res = await callApi(page, "/api/machine/plan", { qq: "keep", xo: "remove", seen });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^xo: "remove" is not one of keep$/);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

/** Call the form's API from the page, as the page does (its token, our origin). */
async function callApi(page: Page, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ([path, body]) => {
      const init: RequestInit = { headers: { "x-qq-setup": String(sessionStorage.getItem("qq-setup-token")), "content-type": "application/json" } };
      if (body !== undefined) Object.assign(init, { method: "POST", body: JSON.stringify(body) });
      const r = await fetch(path, init);
      return { status: r.status, body: await r.json() };
    },
    [path, body] as const,
  );
}

test("this machine: a choice made after the machine changed shows what is there now, and plans nothing", async ({ browser }) => {
  const home = homeWithXo();
  const cli = await startCli({ HOME: home, SHELL: "/bin/zsh" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    const xo = page.getByRole("radiogroup", { name: "What to do with xo" });
    await expect(xo.getByRole("radio", { name: "Keep" })).toBeChecked();
    // Behind the page's back, ~/.xo stops being xo's venv.
    rmSync(join(home, ".xo", "pyvenv.cfg"));
    // click, not check: the page looks again at once, and the radio it clicked goes away.
    await xo.getByRole("radio", { name: "Remove" }).click();
    await expect(page.getByText(/this machine changed since the page looked at it.*Pick again/)).toBeVisible();
    await expect(page.getByText("Move ~/.xo away to install xo here; qq-setup leaves it alone.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run" })).toBeDisabled();
    expect(existsSync(join(home, ".xo"))).toBe(true);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("this machine: the form cannot close under a run, and no run starts once the form has its answer", async ({ browser }) => {
  const home = homeWithXo('sleep 2; echo "fake xo: logged out"');
  const cli = await startCli({ HOME: home, SHELL: "/bin/zsh" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await expect(page.getByRole("radiogroup", { name: "What to do with xo" })).toBeVisible();
    const seen = (await callApi(page, "/api/machine")).body.seen;
    const plan = await callApi(page, "/api/machine/plan", { xo: "remove", seen });
    expect(plan.status).toBe(200);
    expect((await callApi(page, "/api/machine/run", { id: plan.body.id })).status).toBe(200);
    // While xo logout runs: no answer closes the form, and nothing else plans.
    const done = await callApi(page, "/api/answers", { mode: "done" });
    expect(done.status).toBe(409);
    expect(done.body.error).toMatch(/still running/);
    expect((await callApi(page, "/api/machine/plan", { xo: "remove", seen })).body.error).toMatch(/a run is going/);
    await expect.poll(async () => (await callApi(page, "/api/machine/run?from=0")).body.running, { timeout: 15_000 }).toBe(false);

    // Once the form has its answer, a plan made before it cannot run.
    const seen2 = (await callApi(page, "/api/machine")).body.seen;
    const late = await callApi(page, "/api/machine/plan", { xo: "install", seen: seen2 });
    expect(late.status).toBe(200);
    expect((await callApi(page, "/api/answers", { mode: "done" })).status).toBe(200);
    const run = await callApi(page, "/api/machine/run", { id: late.body.id });
    expect(run.status).toBe(409);
    expect(run.body.error).toMatch(/already has your answers/);
    expect(await cli.exited).toBe(0);
    expect(existsSync(join(home, ".xo"))).toBe(false);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("this machine: with a relative HOME the panel offers nothing", async ({ browser }) => {
  const cli = await startCli({ HOME: "relative-home" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await expect(page.getByText("Could not look at this machine")).toBeVisible();
    await expect(page.getByText(/HOME must be set to an absolute path/)).toBeVisible();
    const plan = await callApi(page, "/api/machine/plan", { qq: "remove", seen: "" });
    expect(plan.status).toBe(409);
    expect(plan.body.error).toMatch(/HOME must be set to an absolute path/);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("without a gh login, setting up repos is refused even when asked directly", async ({ browser }) => {
  const cli = await startCli({ FAKE_GH_NO_LOGIN: "1" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await expect(page.getByRole("radio", { name: "Set up repos in an org I own" })).toBeDisabled();
    const r = await callApi(page, "/api/answers", { org: "acme-labs", repos: ["web"], starter: null });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^setting up repos needs GitHub: /);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

/** A HOME with qq installed as its guide leaves it: a clean clone of a local stand-in for quirq-ai/qq
 * (which `git ls-remote` is pointed at too), qqsync at its pin, and the PATH line. */
function homeWithQq(slowLook = false): { home: string; depot: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), "qq-setup-e2e-qq-"));
  const remote = join(mkdtempSync(join(tmpdir(), "qq-setup-e2e-remote-")), "qq.git");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { stdio: "pipe" });
  git("init", "-q", "--bare", remote);
  const depot = join(home, "qq-tools", "depot");
  git("clone", "-q", remote, depot);
  mkdirSync(join(depot, "bin"));
  writeFileSync(join(depot, "bin", "qq"), "#!/bin/sh\necho qq\n", { mode: 0o755 });
  git("-C", depot, "add", ".");
  git("-C", depot, "commit", "-q", "-m", "qq");
  git("-C", depot, "push", "-q", "origin", "HEAD");
  mkdirSync(join(home, "qq-tools", "qqsync", "bin"), { recursive: true });
  writeFileSync(join(home, "qq-tools", "qqsync", "bin", "pip"), `#!/bin/sh\n${slowLook ? "sleep 1\n" : ""}echo "qqsync @ git+https://github.com/quirq-ai/sync@${SYNC_PIN}"\n`, { mode: 0o755 });
  mkdirSync(join(home, "qq-tools", "bin"));
  writeFileSync(join(home, "qq-tools", "bin", "qq"), "");
  writeFileSync(join(home, ".zshrc"), '\nexport PATH="$HOME/qq-tools/bin:$PATH"\n');
  const env = { HOME: home, SHELL: "/bin/zsh", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/quirq-ai/qq" };
  return { home, depot, env };
}

test("this machine: local work made after the page looked is never deleted unwarned", async ({ browser }) => {
  const { depot, env } = homeWithQq();
  const cli = await startCli(env);
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    const qq = page.getByRole("radiogroup", { name: "What to do with qq" });
    await expect(page.getByText(/installed at [0-9a-f]{7} \(the newest\).*up to date/)).toBeVisible();
    await expect(qq.getByRole("radio", { name: "Keep" })).toBeChecked();
    // Work made after the page looked: picking Update gets no plan, and the page looks again.
    writeFileSync(join(depot, "MY-NOTES.txt"), "mine");
    await qq.getByRole("radio", { name: "Update" }).click();
    await expect(page.getByText(/this machine changed since the page looked at it.*Pick again/)).toBeVisible();
    await expect(page.getByText(/with local work \(uncommitted or untracked files\)/)).toBeVisible();
    await expect(qq.getByRole("radio", { name: "Keep" })).toBeChecked();
    await expect(page.getByText("rm -rf ~/qq-tools/depot", { exact: false })).toHaveCount(0);
    // Now it is on screen: Update and Remove each say what they delete.
    for (const pick of ["Update", "Remove"]) {
      await qq.getByRole("radio", { name: pick }).click();
      await expect(page.getByText("This deletes your local work in qq")).toBeVisible();
      await expect(page.getByText(/Pick again/)).toHaveCount(0);
    }
    await qq.getByRole("radio", { name: "Keep" }).click();
    await expect(page.getByText("This deletes your local work in qq")).toHaveCount(0);
    expect(existsSync(join(depot, "MY-NOTES.txt"))).toBe(true);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("this machine: while a choice's steps are on their way, the steps of the last choice are not shown or run", async ({ browser }) => {
  const { env } = homeWithQq();
  const cli = await startCli(env);
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    const qq = page.getByRole("radiogroup", { name: "What to do with qq" });
    await qq.getByRole("radio", { name: "Update" }).click();
    await expect(page.getByRole("button", { name: "Run these 3 steps" })).toBeEnabled();
    // Hold the next plan: until it arrives, Update's steps must not stay on screen under Remove.
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise<void>((ok) => (release = ok));
    await page.route("**/api/machine/plan", async (route) => (await held, route.continue()));
    await qq.getByRole("radio", { name: "Remove" }).click();
    await expect(page.getByText("Working out the steps…")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Run/ })).toBeDisabled();
    await expect(page.getByText("Install qq", { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("button", { name: "Run these 2 steps" })).toBeEnabled();
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("this machine: no run starts while an org answer waits on GitHub, so the form never closes under one", async ({ browser }) => {
  const home = homeWithXo();
  const cli = await startCli({ HOME: home, SHELL: "/bin/zsh", FAKE_GH_SLOW: "repos/acme-labs/new-app" });
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    await expect(page.getByRole("radiogroup", { name: "What to do with xo" })).toBeVisible();
    const seen = (await callApi(page, "/api/machine")).body.seen;
    const plan = await callApi(page, "/api/machine/plan", { xo: "remove", seen });
    expect(plan.status).toBe(200);
    expect((await callApi(page, "/api/repos?org=acme-labs")).status).toBe(200);
    const answer = callApi(page, "/api/answers", { org: "acme-labs", repos: ["web"], starter: { name: "new-app", kind: "node-app" } });
    await new Promise((ok) => setTimeout(ok, 800));
    const run = await callApi(page, "/api/machine/run", { id: plan.body.id });
    expect(run.status).toBe(409);
    expect(run.body.error).toMatch(/on its way to the terminal/);
    expect((await answer).status).toBe(200);
    expect(await cli.exited).toBe(0);
    expect(cli.output()).not.toContain("Running the steps picked in the form:");
    expect(existsSync(join(home, ".xo"))).toBe(true);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});

test("this machine: quick changes of choice settle on the last one", async ({ browser }) => {
  // A look that takes about a second, as on a real machine (pip freeze, git ls-remote).
  const { env } = homeWithQq(true);
  const cli = await startCli(env);
  const page = await browser.newPage();
  try {
    await page.goto(cli.url);
    const qq = page.getByRole("radiogroup", { name: "What to do with qq" });
    await expect(qq.getByRole("radio", { name: "Keep" })).toBeChecked();
    await expect(page.getByText("Nothing to do with these choices.")).toBeVisible();
    // Remove, Keep, Remove faster than a look takes: each request makes the one before it stale.
    for (const pick of ["Remove", "Keep", "Remove"]) await qq.getByRole("radio", { name: pick }).click();
    await expect(page.getByRole("button", { name: "Run these 2 steps" })).toBeEnabled({ timeout: 8_000 });
    await expect(page.getByText("Working out the steps…")).toHaveCount(0);
  } finally {
    cli.proc.kill();
    await page.close();
  }
});
