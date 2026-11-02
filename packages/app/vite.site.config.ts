import { defineConfig } from "vite";
import { sharedFileName, sharedInputs, sharedModules } from "./vite.shared.ts";

/**
 * The site runtime, copied into every published artifact under
 * `_assets/docleus/`. Every URL is relative so artifacts work under any
 * path prefix and on any host.
 */
export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [sharedModules("")],
  build: {
    outDir: "dist-site",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: { runtime: "src/site/runtime.ts", ...sharedInputs() },
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) =>
          sharedFileName(chunk.facadeModuleId) ?? "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
