import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DEV_SCRIPT = fileURLToPath(
  new URL("../../../scripts/dev.ts", import.meta.url),
);
const EXIT_TIMEOUT_MS = 20_000;

/** Runs `pnpm docleus` from source; resolves to its exit code, or `undefined` when it does not exit in time. */
function runDev(args: readonly string[]) {
  return new Promise<{ code: number | null | undefined; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [DEV_SCRIPT, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: undefined, stdout });
      }, EXIT_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
    },
  );
}

describe("scripts/dev.ts", () => {
  it(
    "exits once a one-shot command finishes",
    async () => {
      const result = await runDev(["--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("usage");
    },
    EXIT_TIMEOUT_MS + 10_000,
  );
});
