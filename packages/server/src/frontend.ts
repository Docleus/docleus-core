import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { DocleusError } from "@docleus/kernel";
import { z } from "zod";
import type { Manifest } from "@docleus/sdk";

const APP_PREFIX = "/_app/";
const PLUGIN_PREFIX = "/_plugins/";
/** Written by the `@docleus/app` build next to `index.html`. */
const APP_IMPORT_MAP = "importmap.json";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
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
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const importMapSchema = z.object({
  imports: z.record(z.string(), z.string()),
});

/** A mounted plugin as the frontend sees it. */
export interface MountedPlugin {
  readonly manifest: Manifest;
  readonly dir: string;
}

export interface FrontendOptions {
  readonly plugins: ReadonlyMap<string, MountedPlugin>;
  readonly appDir?: string;
}

export interface Frontend {
  /** The URL a plugin file is served from, `path` relative to the plugin directory. */
  pluginUrl(plugin: string, path: string): string;
  readonly importMap: { readonly imports: Readonly<Record<string, string>> };
  /** Serves `/_app/`, `/_plugins/` and the app shell for every other HTML request. */
  serve(request: Request): Promise<Response>;
  /**
   * Throws what `refresh` would throw for `plugins` (such as an expose of a
   * host module), without changing what is served.
   */
  check(plugins: ReadonlyMap<string, MountedPlugin>): void;
  /** Rebuilds the plugin roots, import map and shell after the plugin map changed. */
  refresh(): void;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function commonDir(paths: readonly string[]): string | undefined {
  const [first, ...rest] = paths.map((path) => dirname(path).split(sep));
  if (!first) return undefined;
  let length = first.length;
  for (const parts of rest) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i++;
    length = i;
  }
  return first.slice(0, length).join(sep) || sep;
}

/** Only the directory holding a plugin's browser files is served. */
function browserRoot({ manifest, dir }: MountedPlugin): string | undefined {
  const files = [
    manifest.entries.editor,
    manifest.entries.site,
    ...Object.values(manifest.exposes),
    ...Object.values(manifest.islands),
  ]
    .filter((file): file is string => file !== undefined)
    .map((file) => resolve(dir, file));
  const root = commonDir(files);
  return root !== undefined && isInside(dir, root) ? root : undefined;
}

async function serveFile(root: string, path: string): Promise<Response> {
  const file = resolve(root, `.${path}`);
  const type = CONTENT_TYPES[extname(file)];
  if (!isInside(root, file) || type === undefined) return notFound();
  try {
    if (!(await stat(file)).isFile()) return notFound();
    return new Response(await readFile(file), {
      headers: {
        "content-type": type,
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return notFound();
  }
}

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function escapeScript(json: string): string {
  return json.replaceAll("<", "\\u003c");
}

function readAppImportMap(appDir: string): Record<string, string> {
  const path = resolve(appDir, APP_IMPORT_MAP);
  try {
    return importMapSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      .imports;
  } catch (error) {
    throw new DocleusError(
      "frontend/invalid-app",
      `cannot read the app import map at ${path}`,
      { cause: error },
    );
  }
}

const NO_APP_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Docleus</title></head><body><p>The Docleus app is not built. Run <code>pnpm --filter @docleus/app build</code>.</p></body></html>`;

interface FrontendState {
  readonly roots: ReadonlyMap<string, string>;
  readonly importMap: { readonly imports: Readonly<Record<string, string>> };
  readonly shell: string;
}

function urlOf(
  roots: ReadonlyMap<string, string>,
  plugins: ReadonlyMap<string, MountedPlugin>,
  plugin: string,
  path: string,
): string {
  const root = roots.get(plugin);
  const mounted = plugins.get(plugin);
  if (!root || !mounted) {
    throw new DocleusError(
      "frontend/no-browser-files",
      `plugin "${plugin}" has no browser files`,
    );
  }
  const rel = relative(root, resolve(mounted.dir, path)).split(sep);
  return `${PLUGIN_PREFIX}${encodeURIComponent(plugin)}/${rel.map(encodeURIComponent).join("/")}`;
}

function buildState(
  plugins: ReadonlyMap<string, MountedPlugin>,
  appImports: Readonly<Record<string, string>>,
  appShell: string | undefined,
): FrontendState {
  const roots = new Map<string, string>();
  for (const [name, plugin] of plugins) {
    const root = browserRoot(plugin);
    if (root) roots.set(name, root);
  }
  const imports: Record<string, string> = { ...appImports };
  const hostKeys = new Set(Object.keys(appImports));
  for (const [name, { manifest }] of plugins) {
    for (const [specifier, path] of Object.entries(manifest.exposes)) {
      if (hostKeys.has(specifier)) {
        throw new DocleusError(
          "plugin/expose-conflict",
          `${name} exposes "${specifier}", which the host provides`,
        );
      }
      imports[specifier] = urlOf(roots, plugins, name, path);
    }
  }
  const importMap = { imports };
  const shell =
    appShell?.replace(
      "<head>",
      `<head><script type="importmap">${escapeScript(JSON.stringify(importMap))}</script>`,
    ) ?? NO_APP_SHELL;
  return { roots, importMap, shell };
}

/**
 * The browser side of an instance: the app shell with the host import map,
 * the app's static files, and each plugin's browser files.
 */
export function createFrontend(options: FrontendOptions): Frontend {
  const appImports: Readonly<Record<string, string>> = options.appDir
    ? readAppImportMap(options.appDir)
    : {};
  const appShell = options.appDir
    ? readFileSync(resolve(options.appDir, "index.html"), "utf8")
    : undefined;
  let state = buildState(options.plugins, appImports, appShell);

  return {
    pluginUrl: (plugin, path) =>
      urlOf(state.roots, options.plugins, plugin, path),
    get importMap() {
      return state.importMap;
    },
    check(plugins) {
      buildState(plugins, appImports, appShell);
    },
    refresh() {
      state = buildState(options.plugins, appImports, appShell);
    },
    async serve(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return notFound();
      }
      if (pathname.startsWith(PLUGIN_PREFIX)) {
        const rest = pathname.slice(PLUGIN_PREFIX.length);
        const slash = rest.indexOf("/");
        if (slash < 0) return notFound();
        const root = state.roots.get(decode(rest.slice(0, slash)) ?? "");
        const file = decode(rest.slice(slash));
        if (!root || file === undefined) return notFound();
        return serveFile(root, file);
      }
      if (pathname.startsWith(APP_PREFIX)) {
        const file = decode(pathname.slice(APP_PREFIX.length - 1));
        if (!options.appDir || file === undefined) return notFound();
        return serveFile(options.appDir, file);
      }
      if (!(request.headers.get("accept") ?? "").includes("text/html")) {
        return notFound();
      }
      return new Response(state.shell, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    },
  };
}
