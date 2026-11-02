import {
  DocleusError,
  escapeHtml,
  escapeScriptJson,
  type Context,
  type DispatchScope,
  type PluginLock,
  type Site,
  type SitePage,
  type Space,
} from "@docleus/sdk";
import {
  RUNTIME_PREFIX,
  contentTypeOf,
  filesSha256,
  normalizePluginPath,
  parseRuntimeImportMap,
  pluginAssetDir,
  sha256,
  siteBrowserRoot,
  underRoot,
  type SiteAssetSource,
  type SitePluginSource,
} from "./assets.ts";
import { placePages } from "./pages.ts";
import { NOT_FOUND_BASE, NOT_FOUND_PATH } from "./serve.ts";

type Logger = ReturnType<Context["logger"]>;

export interface BuildOptions {
  readonly assets: SiteAssetSource;
  readonly revisions?: Readonly<Record<string, string>>;
  readonly logger: Logger;
}

export interface BuiltFile {
  readonly bytes: Uint8Array;
  readonly type: string;
}

export interface BuiltSite {
  /** Keyed by site-relative path. */
  readonly files: ReadonlyMap<string, BuiltFile>;
  readonly revisions: Readonly<Record<string, string>>;
  readonly themeSettings: unknown;
  readonly lockfile: readonly PluginLock[];
}

interface PublishedSpace {
  readonly space: Space;
  readonly revision: string;
  readonly scope: DispatchScope & { readonly [filter: symbol]: unknown };
  /** Plugins enabled in this space, by name. */
  readonly enabled: ReadonlySet<string>;
}

interface CopiedPlugin {
  readonly source: SitePluginSource;
  /** Plugin-relative, `""` for the plugin directory itself. */
  readonly root: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const PAGE_TYPE = "text/html; charset=utf-8";
const encoder = new TextEncoder();

/** `./` at the site root, `../` one level down, and so on. */
export function relativePrefix(path: string): string {
  const depth = path.split("/").filter((segment) => segment !== "").length;
  return depth === 0 ? "./" : "../".repeat(depth);
}

function byName(a: SitePluginSource, b: SitePluginSource): number {
  const x = a.manifest.name;
  const y = b.manifest.name;
  return x < y ? -1 : x > y ? 1 : 0;
}

async function resolveRevisions(
  ctx: Context,
  site: Site,
  requested: Readonly<Record<string, string>> | undefined,
): Promise<Record<string, string>> {
  const listed = new Set(site.spaces.map((space) => space.spaceId));
  for (const spaceId of Object.keys(requested ?? {})) {
    if (!listed.has(spaceId)) {
      throw new DocleusError(
        "sites/invalid-revision",
        `space "${spaceId}" is not part of site "${site.id}"`,
      );
    }
  }
  const revisions: Record<string, string> = {};
  for (const { spaceId } of site.spaces) {
    const wanted = requested?.[spaceId];
    if (wanted === undefined) {
      const head = await ctx.content.head(spaceId);
      if (!head) {
        throw new DocleusError(
          "sites/space-empty",
          `space "${spaceId}" has no revision to publish`,
        );
      }
      revisions[spaceId] = head.id;
      continue;
    }
    const revision = await ctx.content.getRevision(wanted);
    if (revision?.spaceId !== spaceId) {
      throw new DocleusError(
        "sites/invalid-revision",
        `revision "${wanted}" is not a revision of space "${spaceId}"`,
      );
    }
    revisions[spaceId] = revision.id;
  }
  return revisions;
}

/**
 * Renders every page and file of `site` and collects the browser files
 * its pages load. Nothing is stored.
 */
export async function buildSite(
  ctx: Context,
  site: Site,
  options: BuildOptions,
): Promise<BuiltSite> {
  const revisions = await resolveRevisions(ctx, site, options.revisions);
  const orgSpaces = new Map(
    (await ctx.content.listSpaces(site.orgId)).map((space) => [
      space.id,
      space,
    ]),
  );
  const sources = [...options.assets.plugins()].toSorted(byName);

  const published: PublishedSpace[] = [];
  const entries = [];
  for (const { spaceId, path } of site.spaces) {
    const space = orgSpaces.get(spaceId);
    const revision = revisions[spaceId];
    if (!space || revision === undefined) {
      throw new DocleusError(
        "sites/invalid-spaces",
        `space "${spaceId}" does not exist in org "${site.orgId}"`,
      );
    }
    const scopeOf = { kind: "space", orgId: site.orgId, spaceId } as const;
    const enabled = new Set<string>();
    for (const source of sources) {
      if (await ctx.installations.isEnabled(source.manifest.name, scopeOf)) {
        enabled.add(source.manifest.name);
      }
    }
    published.push({
      space,
      revision,
      scope: await ctx.installations.scope(scopeOf),
      enabled,
    });
    entries.push({ path, entries: await ctx.content.listEntries(revision) });
  }
  const [first] = published;
  if (!first) {
    throw new DocleusError("sites/invalid-spaces", "a site needs a space");
  }

  const lockfile: PluginLock[] = [];
  const copied = new Map<string, CopiedPlugin>();
  for (const source of sources) {
    const { name } = source.manifest;
    if (!published.some((space) => space.enabled.has(name))) continue;
    const root = siteBrowserRoot(source.manifest);
    const files =
      root === undefined
        ? new Map<string, Uint8Array>()
        : await source.readFiles(root);
    if (root !== undefined) copied.set(name, { source, root, files });
    lockfile.push({
      name,
      version: source.manifest.version,
      manifestSha256: sha256(source.manifestBytes),
      filesSha256: filesSha256(files),
    });
  }

  const runtime = await options.assets.runtime();
  const importMap = parseRuntimeImportMap(runtime);
  const themeName = ctx.render.resolveTheme(site.theme, { scope: first.scope });
  const themeSettings =
    themeName === undefined
      ? undefined
      : await ctx.installations.getSettings(themeName, {
          kind: "space",
          orgId: site.orgId,
          spaceId: first.space.id,
        });
  const siteInfo = { id: site.id, name: site.name, settings: themeSettings };

  function pluginFileUrl(prefix: string, name: string, file: string): string {
    const plugin = copied.get(name);
    const relative = plugin && underRoot(plugin.root, file);
    if (!plugin || relative === undefined || !plugin.files.has(relative)) {
      throw new DocleusError(
        "sites/invalid-asset",
        `"${file}" of plugin "${name}" is not a published browser file`,
      );
    }
    return `${prefix}${pluginAssetDir(plugin.source.manifest)}${relative}`;
  }

  function headOf(prefix: string, space: PublishedSpace): string {
    const imports = Object.fromEntries(
      Object.entries(importMap).map(([specifier, path]) => [
        specifier,
        `${prefix}${RUNTIME_PREFIX}${path}`,
      ]),
    );
    const scripts = sources
      .filter(
        ({ manifest }) =>
          manifest.entries.site !== undefined &&
          space.enabled.has(manifest.name),
      )
      .map(({ manifest }) => {
        const url = pluginFileUrl(
          prefix,
          manifest.name,
          manifest.entries.site ?? "",
        );
        return `<script type="module" src="${escapeHtml(url)}"></script>`;
      });
    return [
      `<script type="importmap">${escapeScriptJson({ imports })}</script>`,
      `<script type="module" src="${escapeHtml(`${prefix}${RUNTIME_PREFIX}runtime.js`)}"></script>`,
      ...scripts,
    ].join("");
  }

  function islandUrlOf(prefix: string, space: PublishedSpace) {
    return (type: string): string | undefined => {
      const source = sources.find(
        ({ manifest }) =>
          manifest.islands[type] !== undefined &&
          space.enabled.has(manifest.name),
      );
      const file = source?.manifest.islands[type];
      if (!source || file === undefined) return undefined;
      return pluginFileUrl(prefix, source.manifest.name, file);
    };
  }

  const files = new Map<string, BuiltFile>();
  const placed = placePages(entries);
  const pages: { page: SitePage; space: PublishedSpace }[] = [];
  for (const [index, space] of published.entries()) {
    const { nav, pages: spacePages } = placed[index] ?? { nav: [], pages: [] };
    for (const at of spacePages) {
      const prefix = relativePrefix(at.path);
      pages.push({
        space,
        page: {
          kind: "page",
          site: siteInfo,
          space: space.space,
          revision: space.revision,
          entry: at.entry,
          path: at.path,
          title: at.entry.title,
          nav,
          prev: at.prev,
          next: at.next,
          url: (path) => urlOf(prefix, path),
          asset: (plugin, file) => pluginFileUrl(prefix, plugin, file),
        },
      });
    }
  }

  for (const { page, space } of pages) {
    const prefix = relativePrefix(page.path);
    const result = ctx.render.renderPage(page, {
      scope: space.scope,
      theme: themeName,
      head: headOf(prefix, space),
      islandUrl: islandUrlOf(prefix, space),
    });
    files.set(`${page.path}index.html`, {
      bytes: encoder.encode(result.html),
      type: PAGE_TYPE,
    });
  }

  const notFound: SitePage = {
    kind: "not-found",
    site: siteInfo,
    space: first.space,
    revision: first.revision,
    entry: undefined,
    path: "/",
    title: "Page not found",
    nav: placed[0]?.nav ?? [],
    prev: undefined,
    next: undefined,
    url: (path) => urlOf("./", path),
    asset: (plugin, file) => pluginFileUrl("./", plugin, file),
  };
  files.set(NOT_FOUND_PATH, {
    bytes: encoder.encode(
      ctx.render.renderPage(notFound, {
        scope: first.scope,
        theme: themeName,
        head: `${NOT_FOUND_BASE}${headOf("./", first)}`,
        islandUrl: islandUrlOf("./", first),
      }).html,
    ),
    type: PAGE_TYPE,
  });

  for (const [path, bytes] of runtime) {
    files.set(`/${RUNTIME_PREFIX}${path}`, {
      bytes,
      type: contentTypeOf(path),
    });
  }
  for (const { source, files: pluginFiles } of copied.values()) {
    for (const [path, bytes] of pluginFiles) {
      files.set(`/${pluginAssetDir(source.manifest)}${path}`, {
        bytes,
        type: contentTypeOf(path),
      });
    }
  }

  const generated = ctx.render.renderFiles(
    { site: siteInfo, pages: pages.map(({ page }) => page) },
    { scope: first.scope },
  );
  for (const [path, file] of generated) {
    const normalized = normalizePluginPath(path.replace(/^\/+/, ""));
    if (
      !path.startsWith("/") ||
      normalized === undefined ||
      normalized === ""
    ) {
      options.logger.warn("skipping site file with invalid path %s", path);
      continue;
    }
    const key = `/${normalized}`;
    if (files.has(key)) {
      options.logger.warn("skipping site file %s: the path is taken", key);
      continue;
    }
    files.set(key, {
      bytes:
        typeof file.body === "string" ? encoder.encode(file.body) : file.body,
      type: file.type,
    });
  }

  return { files, revisions, themeSettings, lockfile };
}

function urlOf(prefix: string, path: string): string {
  const rest = path.replace(/^\/+/, "");
  return rest === "" ? prefix : `${prefix}${rest}`;
}
