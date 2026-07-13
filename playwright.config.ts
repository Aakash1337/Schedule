import { defineConfig, devices } from "@playwright/test";

function requiredPort(name: "E2E_API_PORT" | "E2E_WEB_PORT"): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return value;
}

const apiPort = requiredPort("E2E_API_PORT");
const webPort = requiredPort("E2E_WEB_PORT");
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./apps/web/e2e",
  outputDir: "./test-results/browser-e2e",
  forbidOnly: process.env.CI === "true",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter:
    process.env.CI === "true"
      ? [["line"], ["html", { outputFolder: "playwright-report/browser-e2e", open: "never" }]]
      : [["list"], ["html", { outputFolder: "playwright-report/browser-e2e", open: "never" }]],
  use: {
    baseURL: webUrl,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @schedule/api start",
      url: `${apiUrl}/health/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `pnpm --filter @schedule/web preview --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
