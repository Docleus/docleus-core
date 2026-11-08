import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DocleusError } from "@docleus/kernel";
import {
  definePlugin,
  parseManifest,
  satisfiesRange,
  type DocleusPlugin,
  type Manifest,
} from "@docleus/sdk";

export const PLATFORM_VERSION = "0.0.5";

export function readManifest(dir: string): Manifest {
  const path = resolve(dir, "docleus.plugin.json");
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new DocleusError(
      "plugin/invalid-manifest",
      `invalid manifest at ${path}`,
      {
        cause: error,
      },
    );
  }
  if (!satisfiesRange(PLATFORM_VERSION, manifest.engines.docleus)) {
    throw new DocleusError(
      "plugin/engines-mismatch",
      `${manifest.name} requires docleus ${manifest.engines.docleus}, running ${PLATFORM_VERSION}`,
    );
  }
  return manifest;
}

/** The directory of a local plugin specifier. */
export function resolvePluginDir(baseDir: string, specifier: string): string {
  return isAbsolute(specifier) ? specifier : resolve(baseDir, specifier);
}

/** Reads the manifest of a local plugin specifier, for `PluginHostOptions.manifest`. */
export function createLocalManifestReader(baseDir: string) {
  return (specifier: string): Manifest =>
    readManifest(resolvePluginDir(baseDir, specifier));
}

/**
 * Resolves a local plugin specifier to its server plugin. A plugin without a
 * server entry (an editor-only plugin) resolves to an empty plugin under its
 * manifest name, so it is mounted, installed and enabled like any other.
 */
export function createLocalResolver(baseDir: string) {
  return async (specifier: string): Promise<DocleusPlugin<never>> => {
    const dir = resolvePluginDir(baseDir, specifier);
    const manifest = readManifest(dir);
    const entry = manifest.entries.server;
    if (!entry) return definePlugin({ name: manifest.name, apply() {} });
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(resolve(dir, entry)).href
    )) as {
      plugin?: DocleusPlugin<never>;
    };
    if (!module.plugin) {
      throw new DocleusError(
        "plugin/no-plugin-export",
        `${manifest.name}: ${resolve(dir, entry)} does not export "plugin"`,
      );
    }
    return module.plugin;
  };
}
