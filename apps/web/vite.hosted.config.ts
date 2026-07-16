import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/hosted",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./hosted.html", import.meta.url)),
    },
  },
});
