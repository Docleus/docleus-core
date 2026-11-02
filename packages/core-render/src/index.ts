import { Context, DocleusError } from "@docleus/kernel";
import {
  ISLAND_SCRIPT_ID,
  escapeHtml,
  escapeScriptJson,
  trackCaller,
  type BlockNode,
  type BlockRenderer,
  type DispatchScope,
  type IslandManifest,
  type JsonValue,
  type RenderContext,
  type RenderOptions,
  type RenderPageOptions,
  type RenderResult,
  type RenderService,
  type SiteFile,
  type SiteFileGenerator,
  type SiteLayoutInput,
  type SiteSlot,
  type SiteSlotItem,
  type SiteTheme,
} from "@docleus/sdk";
import { bareLayout } from "./bare-layout.ts";
import { createSlugger } from "./slug.ts";

export { slugify } from "./slug.ts";

interface Owned<T> {
  readonly value: T;
  /** The name of the plugin that registered it. */
  readonly owner: string;
}

const DOC_BLOCK_TYPE = "doc";

const NOT_FOUND_BODY: RenderResult = {
  html: "<p>This page does not exist.</p>",
  islands: [],
};

function placeholder(node: BlockNode): RenderResult {
  return {
    html: `<div data-unknown-block="${escapeHtml(node.type)}"></div>`,
    islands: [],
  };
}

function isAllowed(owned: Owned<unknown>, scope?: DispatchScope): boolean {
  return scope === undefined || scope.allows(owned.owner);
}

/** A Cordis dispatch `thisArg` that skips hooks of plugins `scope` does not allow. */
function dispatchFilter(scope: DispatchScope): object {
  return {
    [Context.filter]: (target: Context) => scope.allows(target.fiber.name),
  };
}

function concat(results: readonly RenderResult[]): RenderResult {
  const outline = results.flatMap((result) => result.outline ?? []);
  return {
    html: results.map((result) => result.html).join(""),
    islands: results.flatMap((result) => result.islands),
    ...(outline.length > 0 && { outline }),
  };
}

function islandHead(
  body: RenderResult,
  islandUrl: RenderPageOptions["islandUrl"],
): string {
  if (!islandUrl) return "";
  const modules: Record<string, string> = {};
  const props: Record<string, JsonValue> = {};
  for (const island of body.islands) {
    const url = islandUrl(island.type);
    if (url === undefined) continue;
    modules[island.type] = url;
    if (island.props !== undefined) props[island.blockId] = island.props;
  }
  if (Object.keys(modules).length === 0) return "";
  const manifest: IslandManifest = { modules, props };
  // The runtime imports the modules only once it has read the manifest, so
  // the browser starts fetching them early instead.
  const preloads = [...new Set(Object.values(modules))].map(
    (url) => `<link rel="modulepreload" href="${escapeHtml(url)}">`,
  );
  return `${preloads.join("")}<script type="application/json" id="${ISLAND_SCRIPT_ID}">${escapeScriptJson(manifest)}</script>`;
}

/**
 * Default `render` implementation: in-memory registries of block
 * renderers, site themes, layout slots and generated files. Unknown types
 * fall back to a safe placeholder rather than throwing.
 *
 * @stability experimental
 */
export function createRenderService(ctx: Context): RenderService {
  const renderers = new Map<string, Owned<BlockRenderer>>();
  const themes = new Map<string, Owned<SiteTheme>>();
  const slots = new Map<SiteSlot, Owned<SiteSlotItem>[]>();
  const files = new Map<string, Owned<SiteFileGenerator>>();

  function register<K, T>(
    caller: Context,
    registry: Map<K, Owned<T>>,
    key: K,
    value: T,
    describe: () => [code: string, message: string, label: string],
  ): () => void {
    const [code, message, label] = describe();
    return caller.effect(() => {
      if (registry.has(key)) throw new DocleusError(code, message);
      registry.set(key, { value, owner: caller.fiber.name });
      return () => registry.delete(key);
    }, label);
  }

  function renderTree(
    node: BlockNode,
    scope: DispatchScope | undefined,
  ): RenderResult {
    const slugger = createSlugger();
    const context: RenderContext = {
      children: (parent) =>
        concat((parent.content ?? []).map((child) => renderNode(child))),
      anchor: slugger,
    };
    function renderNode(child: BlockNode): RenderResult {
      const owned = renderers.get(child.type);
      if (!owned && child.type === DOC_BLOCK_TYPE) {
        return context.children(child);
      }
      if (!owned || !isAllowed(owned, scope)) return placeholder(child);
      return owned.value(child, context);
    }
    return renderNode(node);
  }

  function resolveTheme(
    name: string | undefined,
    options: RenderOptions = {},
  ): string | undefined {
    const named = name === undefined ? undefined : themes.get(name);
    if (named && isAllowed(named, options.scope)) return name;
    for (const [candidate, owned] of themes) {
      if (isAllowed(owned, options.scope)) return candidate;
    }
    return undefined;
  }

  function renderSlot(
    slot: SiteSlot,
    input: Pick<SiteLayoutInput, "page">,
    scope: DispatchScope | undefined,
  ): string {
    return (slots.get(slot) ?? [])
      .filter((owned) => isAllowed(owned, scope))
      .map((owned, index) => ({ owned, index }))
      .toSorted(
        (a, b) =>
          (a.owned.value.order ?? 0) - (b.owned.value.order ?? 0) ||
          a.index - b.index,
      )
      .map(({ owned }) => owned.value.render(input.page))
      .join("");
  }

  return trackCaller<RenderService>(ctx, {
    registerBlock(type, renderer) {
      return register(this.ctx, renderers, type, renderer, () => [
        "render/already-registered",
        `a renderer for block type "${type}" is already registered`,
        `ctx.render.registerBlock(${JSON.stringify(type)})`,
      ]);
    },
    render(node, options = {}) {
      return renderTree(node, options.scope);
    },
    registerTheme(name, theme) {
      return register(this.ctx, themes, name, theme, () => [
        "render/theme-taken",
        `a theme named "${name}" is already registered`,
        `ctx.render.registerTheme(${JSON.stringify(name)})`,
      ]);
    },
    resolveTheme,
    registerSlot(slot, item) {
      const caller = this.ctx;
      return caller.effect(
        () => {
          const items = slots.get(slot) ?? [];
          if (items.some((owned) => owned.value.id === item.id)) {
            throw new DocleusError(
              "render/slot-item-taken",
              `slot "${slot}" already has an item "${item.id}"`,
            );
          }
          const owned = { value: item, owner: caller.fiber.name };
          slots.set(slot, [...items, owned]);
          return () => {
            const rest = (slots.get(slot) ?? []).filter((o) => o !== owned);
            if (rest.length > 0) slots.set(slot, rest);
            else slots.delete(slot);
          };
        },
        `ctx.render.registerSlot(${JSON.stringify(slot)}, ${JSON.stringify(item.id)})`,
      );
    },
    registerFile(path, generate) {
      return register(this.ctx, files, path, generate, () => [
        "render/file-taken",
        `a site file "${path}" is already registered`,
        `ctx.render.registerFile(${JSON.stringify(path)})`,
      ]);
    },
    renderPage(page, options = {}) {
      const { scope } = options;
      const body =
        page.kind === "page" && page.entry?.body
          ? renderTree(page.entry.body, scope)
          : NOT_FOUND_BODY;
      const head = [
        options.head ?? "",
        islandHead(body, options.islandUrl),
        renderSlot("site.head", { page }, scope),
      ].join("");
      const input: SiteLayoutInput = {
        page,
        body,
        head,
        slot: (slot) => renderSlot(slot, { page }, scope),
      };
      const themeName = resolveTheme(options.theme, { scope });
      const theme = themeName === undefined ? undefined : themes.get(themeName);
      const inner = (): string =>
        theme ? theme.value.layout(input) : bareLayout(input);
      const html = scope
        ? ctx.waterfall(dispatchFilter(scope), "render/page", input, inner)
        : ctx.waterfall("render/page", input, inner);
      return { ...body, html };
    },
    renderFiles(input, options = {}) {
      const result = new Map<string, SiteFile>();
      for (const [path, owned] of files) {
        if (!isAllowed(owned, options.scope)) continue;
        const file = owned.value(input);
        if (file) result.set(path, file);
      }
      return result;
    },
  });
}

export function provideRender(ctx: Context): () => void {
  return ctx.provide("render", createRenderService(ctx));
}
