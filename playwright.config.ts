import { defineConfig } from "@playwright/test";

const chromiumPath = process.env.PW_CHROMIUM_PATH;

// Each test starts the real CLI (cli/bin.mjs) against tests/fake-gh, so no GitHub call is made.
// Run `npm run build` first: the CLI serves the exported form from out/.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  use: {
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : undefined,
  },
});
