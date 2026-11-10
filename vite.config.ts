import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const isPagesPreview = process.env.GITHUB_PAGES_PREVIEW === "1";

export default defineConfig({
  plugins: [react()],
  base: isPagesPreview ? "/SnapyCall-Pilot-Outreach/" : "/",
  server: { proxy: { "/api": "http://localhost:3000" } },
  build: {
    outDir: "dist",
    rollupOptions: isPagesPreview
      ? { input: resolve(import.meta.dirname, "preview.html") }
      : undefined,
  },
});
