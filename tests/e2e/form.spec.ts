import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "test-results", "screenshots");
// The line that gets a repo: qq fetch, or git clone on a Mac, where qq fetch stops after cloning.
const GET = process.platform === "darwin" ? "git clone" : "qq fetch";
const AS_DARWIN = ["--import", pathToFileURL(join(ROOT, "tests", "e2e", "as-darwin.mjs")).href];

type Cli = { proc: ChildProcess; url: string; output: () => string; exited: Promise<number | null> };

/** Start the real CLI with the fake gh first on PATH and no token variables. */
async function startCli(extra: Record<string, string> = {}, nodeArgs: string[] = []): Promise<Cli> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(ROOT, "tests", "fake-gh")}:${process.env.PATH}`, NO_COLOR: "1", ...extra };
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

for (const scheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`form ${width}px ${scheme}: pick repos and a starter, plan prints in the terminal`, async ({ browser }) => {
      const cli = await startCli();
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 }, colorScheme: scheme });
      try {
        await page.goto(cli.url);
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
    await expect(page.getByRole("radio", { name: /acme-labs/ })).toBeChecked();
    expect(page.url()).not.toContain("key=");
    const cookies = await first.cookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });
    // A reload keeps working on this tab's session.
    await page.reload();
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
        await expect(page.getByRole("radio", { name: /acme-labs/ })).toBeChecked();
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

test("a login that owns no org starts on the install commands", async ({ browser }) => {
  const cli = await startCli({ FAKE_GH_NO_ORGS: "1" });
  const page = await browser.newPage();
  try {
    expect(cli.output()).toContain("owns no GitHub org, so the form can only show how to install qq");
    await page.goto(cli.url);
    await expect(page.getByRole("radio", { name: "Install qq on my machine and work on a repo" })).toBeChecked();
    await expect(page.getByText(/You own no GitHub org yet/)).toBeVisible();
    await expect(page.getByRole("radio", { name: "Set up repos in an org I own" })).toBeDisabled();
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
