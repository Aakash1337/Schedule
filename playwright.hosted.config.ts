import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.HOSTED_E2E_WEB_PORT ?? "4174");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("HOSTED_E2E_WEB_PORT must be a valid TCP port.");
}
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./apps/web/e2e-hosted",
  outputDir: "./test-results/hosted-browser-e2e",
  forbidOnly: process.env.CI === "true",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === "true" ? "line" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @schedule/web exec vite preview --config vite.hosted.config.ts --host 127.0.0.1 --port ${String(port)} --strictPort`,
    url: `http://127.0.0.1:${String(port)}/hosted.html`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
