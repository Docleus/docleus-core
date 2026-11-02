import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SiteAssetSource, SitePluginSource } from "@docleus/core-sites";
import type { MountedPlugin } from "./frontend.ts";

const MANIFEST_FILE = "docleus.plugin.json";

/** Every file under `dir`, keyed by `/`-separated relative path; empty when `dir` does not exist. */
async function readTree(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return files;
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
  for (const path of paths) {
    files.set(relative(dir, path).split(sep).join("/"), await readFile(path));
  }
  return files;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function pluginSource(plugin: MountedPlugin): SitePluginSource {
  return {
    manifest: plugin.manifest,
    manifestBytes: readFileSync(join(plugin.dir, MANIFEST_FILE)),
    async readFiles(dir) {
      const root = resolve(plugin.dir, dir);
      const rel = relative(plugin.dir, root);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return new Map();
      }
      return readTree(root);
    },
  };
}

/**
 * Reads the site runtime from `runtimeDir` and plugin browser files from
 * the mounted plugins' directories. `plugins` is read on every publish, so
 * it may be filled after the source is created.
 */
export function createSiteAssetSource(options: {
  readonly runtimeDir: string | undefined;
  readonly plugins: ReadonlyMap<string, MountedPlugin>;
}): SiteAssetSource {
  return {
    runtime: async () =>
      options.runtimeDir === undefined
        ? new Map()
        : readTree(options.runtimeDir),
    plugins: () => [...options.plugins.values()].map(pluginSource),
  };
}
