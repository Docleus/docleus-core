// Runs the `docleus` command from source. The vendored Cordis needs a real
// TypeScript transform (parameter properties, elided type imports), which
// Node's type stripping does not do, so the CLI runs in a Vite module runner.
// Plugins load through the same runner and share one copy of the SDK.
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  appType: "custom",
  logLevel: "warn",
  server: { middlewareMode: true, hmr: false, ws: false },
});
const runner = createServerModuleRunner(server.environments.ssr, {
  hmr: false,
});
const bin: { isServing?: unknown } = await runner.import(
  fileURLToPath(new URL("../packages/cli/src/bin.ts", import.meta.url)),
);
// A running server keeps loading plugins through the runner; any other
// command is done, and the open Vite server would keep the process alive.
if (bin.isServing !== true) {
  await runner.close();
  await server.close();
}
