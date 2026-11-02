import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_DIST_DIR, SITE_RUNTIME_DIR } from "@docleus/app";

/** `dir` when given, else `fallback` when `marker` was built into it. */
function builtDir(
  dir: string | undefined,
  fallback: string,
  marker: string,
): string | undefined {
  if (dir) return resolve(dir);
  return existsSync(join(fallback, marker)) ? fallback : undefined;
}

export function appDirOption(dir: string | undefined): string | undefined {
  return builtDir(dir, APP_DIST_DIR, "index.html");
}

export function siteRuntimeDirOption(
  dir: string | undefined,
): string | undefined {
  return builtDir(dir, SITE_RUNTIME_DIR, "runtime.js");
}
