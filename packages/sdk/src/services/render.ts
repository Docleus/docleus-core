import type { BlockNode } from "./blocks.ts";
import type { Entry, Space } from "./content.ts";
import type { DispatchScope } from "./installations.ts";

/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * An interactive block on a page. The renderer emits its server markup
 * inside `<div data-island="<type>" data-block="<blockId>">`; in the
 * browser, the module the owning plugin's manifest lists under
 * `islands[type]` is loaded only on pages that contain such a block, and
 * its `mount(element, props)` export is called with that element.
 */
export interface IslandRef {
  readonly blockId: string;
  readonly type: string;
  /** Passed to `mount`, serialized into the page as JSON. */
  readonly props?: JsonValue;
}

/** A heading of a page, for its table of contents. */
export interface OutlineItem {
  /** The `id` of the heading element, unique within the page. */
  readonly anchor: string;
  /** 1 to 6, as in `<h1>` to `<h6>`. */
  readonly depth: number;
  readonly text: string;
}

/** Rendered HTML with the islands it needs and its outline. */
export interface RenderResult {
  readonly html: string;
  readonly islands: readonly IslandRef[];
  /** Headings in document order. */
  readonly outline?: readonly OutlineItem[];
}

/** Helpers a block renderer gets. */
export interface RenderContext {
  /** Renders the node's children and concatenates the result. */
  children(node: BlockNode): RenderResult;
  /**
   * A slug for `text` that is unique within the render: the second
   * "Usage" heading gets `usage-2`. Never empty.
   */
  anchor(text: string): string;
}

/** Renders one block of a registered type to trusted HTML. */
export type BlockRenderer = (
  node: BlockNode,
  context: RenderContext,
) => RenderResult;

/** Options of a render. */
export interface RenderOptions {
  /**
   * Renderers, themes and slots registered by plugins this scope does not
   * allow are skipped: their blocks render as the unknown-block
   * placeholder. Everything is allowed when omitted.
   */
  readonly scope?: DispatchScope;
}

/** A page of a site's navigation. */
export interface SiteNavItem {
  readonly entryId: string;
  readonly title: string;
  /** Site-relative canonical path, starting and ending with `/`. Pass it to {@link SitePage.url}. */
  readonly path: string;
  readonly children: readonly SiteNavItem[];
}

/** A link to another page, such as the previous or next page. */
export interface SiteNavLink {
  readonly title: string;
  readonly path: string;
}

/**
 * Everything a theme needs to lay out one page of a published site. All
 * text is unescaped; escape it with {@link escapeHtml}.
 */
export interface SitePage {
  /** `not-found` is the site's 404 page; it has no entry. */
  readonly kind: "page" | "not-found";
  readonly site: {
    readonly id: string;
    readonly name: string;
    /** The theme's settings for the site's first space, as the theme stored them. */
    readonly settings: unknown;
  };
  readonly space: Space;
  readonly revision: string;
  readonly entry: Entry | undefined;
  /** This page's site-relative path, starting and ending with `/`. */
  readonly path: string;
  readonly title: string;
  readonly nav: readonly SiteNavItem[];
  readonly prev: SiteNavLink | undefined;
  readonly next: SiteNavLink | undefined;
  /**
   * The URL of the site-relative `path`, relative to this page, so a
   * published site works under any prefix, on its own domain, and from a
   * static host.
   */
  url(path: string): string;
  /**
   * The URL of a file of plugin `plugin`, `file` relative to the plugin's
   * directory, relative to this page. Only files under the plugin's
   * browser directory are part of the published site.
   */
  asset(plugin: string, file: string): string;
}

/** Slot names of site layouts. Plugins may add their own through declaration merging. */
export interface SiteSlots {
  /** Inside `<head>`. */
  "site.head": true;
  "site.header": true;
  "site.footer": true;
  "site.sidebar": true;
  /** Above the page body, below its title. */
  "site.page.header": true;
  /** Below the page body. */
  "site.page.footer": true;
}

/** The name of a site slot. */
export type SiteSlot = keyof SiteSlots & string;

/** Trusted HTML that a plugin adds to a site slot. */
export interface SiteSlotItem {
  /** Unique within the slot. */
  readonly id: string;
  /** Ascending; ties keep registration order. Defaults to 0. */
  readonly order?: number;
  /** Trusted HTML. */
  render(page: SitePage): string;
}

/** What a theme's layout gets for one page. */
export interface SiteLayoutInput {
  readonly page: SitePage;
  /** The rendered entry body, or the not-found message. */
  readonly body: RenderResult;
  /**
   * Trusted markup the layout must place inside `<head>`: the import map,
   * the site runtime, island props, the `site.head` slot.
   */
  readonly head: string;
  /** The concatenated items of `slot`, in order. */
  slot(slot: SiteSlot): string;
}

/** A site theme, registered with `render.registerTheme`. */
export interface SiteTheme {
  /** Returns a complete HTML document, starting with `<!doctype html>`. */
  layout(input: SiteLayoutInput): string;
}

/** Input of a file generator: every page of the site being published. */
export interface SiteFileInput {
  readonly site: SitePage["site"];
  readonly pages: readonly SitePage[];
}

/** A generated file of a published site. */
export interface SiteFile {
  readonly body: string | Uint8Array;
  /** A MIME type, such as `text/plain; charset=utf-8`. */
  readonly type: string;
}

/** Generates a file of a published site, or `undefined` to skip it. */
export type SiteFileGenerator = (input: SiteFileInput) => SiteFile | undefined;

/** Options of `render.renderPage`. */
export interface RenderPageOptions extends RenderOptions {
  /** The theme name, resolved with {@link RenderService.resolveTheme}. */
  readonly theme?: string;
  /**
   * Host markup placed at the start of {@link SiteLayoutInput.head}, such
   * as the import map and the site runtime script.
   */
  readonly head?: string;
  /**
   * The URL of the island module for a block type, relative to the page;
   * `undefined` leaves blocks of that type static. The head of a page with
   * islands carries the {@link IslandManifest} and a
   * `<link rel="modulepreload">` for each of its modules.
   */
  islandUrl?(type: string): string | undefined;
}

/**
 * Element id of the `<script type="application/json">` a page with islands
 * carries. Its content is an {@link IslandManifest}.
 */
export const ISLAND_SCRIPT_ID = "docleus-islands";

/** What the site runtime reads to mount a page's islands. */
export interface IslandManifest {
  /** Page-relative module URLs, only for the block types on the page. */
  readonly modules: Readonly<Record<string, string>>;
  /** Props by block id; blocks without props are absent. */
  readonly props: Readonly<Record<string, JsonValue>>;
}

/**
 * Block renderers, site themes, site slots and generated files for published sites.
 *
 * @stability experimental
 */
export interface RenderService {
  /** Throws when `type` already has a renderer. The returned function removes it. */
  registerBlock(type: string, renderer: BlockRenderer): () => void;
  /**
   * Unknown types render as an escaped placeholder, except the core `doc`
   * root, which renders its children unless a renderer is registered for it.
   * Renderer errors propagate.
   */
  render(node: BlockNode, options?: RenderOptions): RenderResult;
  /**
   * Registers a site theme under `name`, conventionally the plugin's name.
   * Throws when `name` is taken. The returned function removes it.
   */
  registerTheme(name: string, theme: SiteTheme): () => void;
  /**
   * The theme a page would use: `name` when it is registered and allowed,
   * otherwise the first registered allowed theme, otherwise `undefined`
   * (the built-in bare layout).
   */
  resolveTheme(
    name: string | undefined,
    options?: RenderOptions,
  ): string | undefined;
  /** Throws when `slot` already has an item with `item.id`. The returned function removes it. */
  registerSlot(slot: SiteSlot, item: SiteSlotItem): () => void;
  /**
   * Adds a file at site-relative `path` (such as `/llms.txt`) to every
   * published site; `undefined` from the generator skips it. Throws when
   * `path` is taken. The returned function removes it.
   */
  registerFile(path: string, generate: SiteFileGenerator): () => void;
  /**
   * Renders a complete HTML document for `page`: the entry body, then the
   * theme layout inside the `render/page` waterfall. When the body has
   * islands with a module, the island script is added to the head.
   */
  renderPage(page: SitePage, options?: RenderPageOptions): RenderResult;
  /** Runs every file generator allowed by `options.scope`, keyed by path. */
  renderFiles(
    input: SiteFileInput,
    options?: RenderOptions,
  ): ReadonlyMap<string, SiteFile>;
}

/**
 * `text` with `&`, `<`, `>`, `"` and `'` escaped for HTML text and attributes.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON safe to embed in a `<script>` element. */
export function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
