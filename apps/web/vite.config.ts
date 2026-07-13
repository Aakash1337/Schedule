import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const apiTarget = process.env.SCHEDULE_API_URL ?? "http://127.0.0.1:4000";
const apiProxy = () => ({
  "/v1": apiTarget,
  "/health": apiTarget,
});

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5_173,
    strictPort: true,
    proxy: apiProxy(),
  },
  preview: {
    host: "127.0.0.1",
    port: 4_173,
    strictPort: true,
    proxy: apiProxy(),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: [...configDefaults.exclude, "e2e/**"],
    css: true,
  },
});
