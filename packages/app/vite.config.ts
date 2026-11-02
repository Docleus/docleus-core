import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { sharedFileName, sharedInputs, sharedModules } from "./vite.shared.ts";

export default defineConfig({
  base: "/_app/",
  plugins: [react(), sharedModules("/_app/")],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: { main: "index.html", ...sharedInputs() },
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) =>
          sharedFileName(chunk.facadeModuleId) ?? "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    environment: "happy-dom",
    restoreMocks: true,
    unstubGlobals: true,
  },
});
