import { defineConfig } from "@playwright/test";

const qaPort = Number(process.env.BLOGBOT_QA_PORT ?? "4173");

export default defineConfig({
  testDir: "./tests/browser",
  globalSetup: "./tests/browser/global-setup.ts",
  outputDir: "test-results/browser",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL: `http://127.0.0.1:${qaPort}/qa.html`,
    channel: "msedge",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
