import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = 4323;
const bundle = fileURLToPath(new URL("tests/e2e/bundle.yaml", import.meta.url));
const data = mkdtempSync(join(tmpdir(), "docleus-core-e2e-"));

// The server loads the built app and the built editor plugins, which live in
// sibling repositories, so the command builds them first.
const command = [
  "pnpm build",
  "pnpm --dir ../docleus-plugin-editor build",
  "pnpm --dir ../docleus-plugin-blocks-commonmark build",
  `pnpm docleus serve --dev --bundle ${bundle} --data ${data} --port ${PORT}`,
].join(" && ");

export default defineConfig({
  testDir: "tests/e2e",
  // Traces stay in the temporary data directory, out of the repository.
  outputDir: join(data, "test-results"),
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command,
    url: `http://127.0.0.1:${PORT}/api/auth/methods`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
