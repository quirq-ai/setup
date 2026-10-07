import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "test-results", "screenshots");

type Cli = { proc: ChildProcess; url: string; output: () => string; exited: Promise<number | null> };

/** Start the real CLI with the fake gh first on PATH and no token variables. */
async function startCli(extra: Record<string, string> = {}): Promise<Cli> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(ROOT, "tests", "fake-gh")}:${process.env.PATH}`, NO_COLOR: "1", ...extra };
  for (const v of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[v];
  const proc = spawn(process.execPath, [join(ROOT, "cli", "bin.mjs"), "--no-browser"], { env });
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
        await expect(page.getByText(/git clone -q https:\/\/github\.com\/quirq-ai\/depot/)).toBeVisible();
        await page.getByLabel("Repo (optional)").fill("innernet");
        await expect(page.getByText("Write it as owner/name, like quirq-ai/innernet.")).toBeVisible();
        await expect(page.getByRole("button", { name: /Print these/ })).toBeDisabled();
        // A pasted link with .git is taken as the owner/name it names.
        await page.getByLabel("Repo (optional)").fill("https://github.com/quirq-ai/innernet.git");
        await expect(page.getByText("qq fetch https://github.com/quirq-ai/innernet", { exact: true })).toBeVisible();
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
        expect(out).toContain("qq fetch https://github.com/quirq-ai/innernet");
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
    expect(cli.output()).toContain("qq fetch https://github.com/OWNER/NAME");
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
    const first = page.getByRole("button", { name: "Copy command" }).first();
    await first.click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await page.locator("pre").first().innerText());
    expect(copied).toMatch(/^\( set -e; mkdir -p ~\/qq-tools; rm -rf ~\/qq-tools\/depot; git clone -q /);
  } finally {
    cli.proc.kill();
    await context.close();
  }
});
