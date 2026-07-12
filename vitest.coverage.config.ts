import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "scripts",
          root: ".",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      "packages/config",
      "packages/domain",
      "packages/application",
      "packages/database",
      "apps/api",
      "apps/worker",
      "apps/web/vite.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}", "scripts/**/*.ts"],
      exclude: ["**/*.{test,spec}.{ts,tsx}", "**/*.d.ts", "apps/web/src/test/**"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
      skipFull: false,
      thresholds: {
        statements: 56,
        branches: 58,
        functions: 59,
        lines: 56,
        "packages/domain/src/**/*.ts": {
          statements: 91,
          branches: 82,
          functions: 92,
          lines: 93,
        },
        "packages/application/src/**/*.ts": {
          statements: 83,
          branches: 76,
          functions: 98,
          lines: 83,
        },
        "apps/api/src/**/*.ts": {
          statements: 73,
          branches: 69,
          functions: 57,
          lines: 74,
        },
        "apps/worker/src/**/*.ts": {
          statements: 85,
          branches: 87,
          functions: 89,
          lines: 87,
        },
        "apps/web/src/**/*.{ts,tsx}": {
          statements: 75,
          branches: 63,
          functions: 69,
          lines: 79,
        },
      },
    },
  },
});
