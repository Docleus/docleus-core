import { createHash } from "node:crypto";
import { posix } from "node:path";
import { DocleusError, type Manifest } from "@docleus/sdk";
import { z } from "zod";

/** A mounted plugin, as publishing sees it. */
export interface SitePluginSource {
  readonly manifest: Manifest;
  /** The bytes of the plugin's `docleus.plugin.json`, for the lockfile. */
  readonly manifestBytes: Uint8Array;
  /**
   * Every file under `dir`, a directory relative to the plugin directory
   * (such as `dist/site`), keyed by path relative to `dir` with `/`
   * separators.
   */
  readFiles(dir: string): Promise<ReadonlyMap<string, Uint8Array>>;
}

/**
 * Where publishing reads the browser files it copies into artifacts. The
 * server implements it over the file system; tests pass files in memory.
 *
 * @stability experimental
 */
export interface SiteAssetSource {
  /**
   * The site runtime build (`runtime.js`, `importmap.json`, vendor modules
   * and chunks), keyed by relative path with `/` separators.
   */
  runtime(): Promise<ReadonlyMap<string, Uint8Array>>;
  /** Every mounted plugin. */
  plugins(): readonly SitePluginSource[];
}

export const RUNTIME_PREFIX = "_assets/docleus/";
export const PLUGIN_PREFIX = "_assets/plugins/";

const importMapSchema = z.object({
  imports: z.record(z.string(), z.string()),
});

/** `@acme/plugin-x` -> `acme-plugin-x`. */
export function pluginSlug(name: string): string {
  return name.replace(/^@/, "").replaceAll("/", "-");
}

export function pluginAssetDir(manifest: Manifest): string {
  return `${PLUGIN_PREFIX}${pluginSlug(manifest.name)}@${manifest.version}/`;
}

/** A plugin-relative path without `./`, or `undefined` when it leaves the plugin directory. */
export function normalizePluginPath(file: string): string | undefined {
  const normalized = posix.normalize(file.replaceAll("\\", "/"));
  if (
    posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return undefined;
  }
  return normalized === "." ? "" : normalized;
}

/**
 * The common directory of the plugin's site entry and island modules,
 * relative to the plugin directory (`""` for the directory itself), or
 * `undefined` when it has neither.
 */
export function siteBrowserRoot(manifest: Manifest): string | undefined {
  const files = [manifest.entries.site, ...Object.values(manifest.islands)]
    .filter((file): file is string => file !== undefined)
    .map((file) => {
      const normalized = normalizePluginPath(file);
      if (normalized === undefined) {
        throw new DocleusError(
          "sites/invalid-plugin-file",
          `${manifest.name}: "${file}" is outside the plugin directory`,
        );
      }
      return normalized.split("/").slice(0, -1);
    });
  const [first, ...rest] = files;
  if (!first) return undefined;
  let length = first.length;
  for (const parts of rest) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i++;
    length = i;
  }
  return first.slice(0, length).join("/");
}

/** `file` (plugin-relative) relative to `root`, or `undefined` when it is outside. */
export function underRoot(root: string, file: string): string | undefined {
  const normalized = normalizePluginPath(file);
  if (normalized === undefined || normalized === "") return undefined;
  if (root === "") return normalized;
  return normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : undefined;
}

export function parseRuntimeImportMap(
  runtime: ReadonlyMap<string, Uint8Array>,
): Readonly<Record<string, string>> {
  const bytes = runtime.get("importmap.json");
  if (!runtime.has("runtime.js") || !bytes) {
    throw new DocleusError(
      "sites/runtime-missing",
      "the site runtime is not built: run `pnpm --filter @docleus/app build`",
    );
  }
  const parsed = importMapSchema.safeParse(
    safeJson(new TextDecoder().decode(bytes)),
  );
  if (!parsed.success) {
    throw new DocleusError(
      "sites/runtime-missing",
      `the site runtime's importmap.json is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data.imports;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 over the sorted paths and contents of `files`; the hash of empty input when there are none. */
export function filesSha256(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].toSorted()) {
    const bytes = files.get(path) ?? new Uint8Array();
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export function contentTypeOf(path: string): string {
  return (
    CONTENT_TYPES[posix.extname(path).toLowerCase()] ??
    "application/octet-stream"
  );
}
