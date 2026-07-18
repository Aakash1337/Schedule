import { defineConfig, devices } from "@playwright/test";

import { parseHostedStagingConfig } from "./scripts/hosted-staging-config";

const staging = parseHostedStagingConfig();

export default defineConfig({
  testDir: "./apps/web/e2e-staging",
  outputDir: "./test-results/hosted-staging",
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: staging.loginTimeoutMs + 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: staging.origin,
    headless: false,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
