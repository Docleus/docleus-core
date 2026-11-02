import {
  ISLAND_SCRIPT_ID,
  type BlockNode,
  type Entry,
  type RenderService,
  type SitePage,
} from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite } from "./suite.ts";

const leaf = (type: string, id = "a"): BlockNode => ({
  id,
  type,
  v: 1,
  attrs: {},
});

const doc = (content: BlockNode[]): BlockNode => ({
  id: "doc",
  type: "test.doc",
  v: 1,
  attrs: {},
  content,
});

function sitePage(overrides: Partial<SitePage> = {}): SitePage {
  const entry: Entry = {
    id: "e1",
    type: "page",
    title: "Intro",
    parent: undefined,
    order: 0,
    fields: {},
    body: doc([leaf("test.para", "p1")]),
  };
  return {
    kind: "page",
    site: { id: "s1", name: "Site", settings: undefined },
    space: { id: "sp1", orgId: "o1", slug: "docs", name: "Docs" },
    revision: "r1",
    entry,
    path: "/",
    title: entry.title,
    nav: [{ entryId: "e1", title: "Intro", path: "/", children: [] }],
    prev: undefined,
    next: undefined,
    url: (path) => `.${path}`,
    asset: (plugin, file) => `./_assets/plugins/${plugin}/${file}`,
    ...overrides,
  };
}

function registerBodyRenderers(render: RenderService): void {
  render.registerBlock("test.doc", (node, context) => context.children(node));
  render.registerBlock("test.para", () => ({
    html: "<p>body text</p>",
    islands: [],
  }));
}

export const renderConformanceSuite = defineConformanceSuite<RenderService>(
  "render",
  [
    {
      name: "an unknown block type renders a placeholder instead of throwing",
      check(render) {
        const result = render.render(leaf("test.unregistered"));
        expect(result.html).not.toBe("");
        expect(result.islands).toEqual([]);
      },
    },
    {
      name: "the placeholder escapes the block type so it cannot inject markup",
      check(render) {
        const result = render.render(leaf("test.<script>"));
        expect(result.html).not.toContain("<script>");
      },
    },
    {
      name: "a doc root without a renderer renders its children",
      check(render) {
        render.registerBlock("test.para", () => ({
          html: "<p>x</p>",
          islands: [],
        }));
        const tree: BlockNode = {
          id: "root",
          type: "doc",
          v: 1,
          attrs: {},
          content: [leaf("test.para", "p1"), leaf("test.para", "p2")],
        };
        expect(render.render(tree).html).toBe("<p>x</p><p>x</p>");
      },
    },
    {
      name: "a registered renderer is used instead of the placeholder",
      check(render) {
        const dispose = render.registerBlock("test.known", () => ({
          html: "<p>known</p>",
          islands: [],
        }));
        expect(render.render(leaf("test.known")).html).toBe("<p>known</p>");
        dispose();
      },
    },
    {
      name: "registering a renderer for an already-registered type throws",
      check(render) {
        render.registerBlock("test.dup", () => ({ html: "", islands: [] }));
        expect(() =>
          render.registerBlock("test.dup", () => ({ html: "", islands: [] })),
        ).toThrow();
      },
    },
    {
      name: "unregistering falls back to the placeholder again",
      check(render) {
        const dispose = render.registerBlock("test.removable", () => ({
          html: "<p>there</p>",
          islands: [],
        }));
        dispose();
        expect(render.render(leaf("test.removable")).html).not.toBe(
          "<p>there</p>",
        );
      },
    },
    {
      name: "a renderer that calls context.children concatenates the rendered children",
      check(render) {
        render.registerBlock("test.child", () => ({
          html: "<li>child</li>",
          islands: [],
        }));
        render.registerBlock("test.parent", (node, context) => ({
          html: `<ul>${context.children(node).html}</ul>`,
          islands: [],
        }));
        const tree: BlockNode = {
          id: "root",
          type: "test.parent",
          v: 1,
          attrs: {},
          content: [leaf("test.child", "c1"), leaf("test.child", "c2")],
        };
        expect(render.render(tree).html).toBe(
          "<ul><li>child</li><li>child</li></ul>",
        );
      },
    },
    {
      name: "islands from nested children are collected up through the parent",
      check(render) {
        render.registerBlock("test.island-child", (node) => ({
          html: "",
          islands: [{ blockId: node.id, type: node.type }],
        }));
        render.registerBlock("test.island-parent", (node, context) =>
          context.children(node),
        );
        const tree: BlockNode = {
          id: "root",
          type: "test.island-parent",
          v: 1,
          attrs: {},
          content: [leaf("test.island-child", "c1")],
        };
        expect(render.render(tree).islands).toEqual([
          { blockId: "c1", type: "test.island-child" },
        ]);
      },
    },
    {
      name: "a renderer error propagates rather than being swallowed",
      check(render) {
        render.registerBlock("test.failing", () => {
          throw new Error("boom");
        });
        expect(() => render.render(leaf("test.failing"))).toThrow("boom");
      },
    },
    {
      name: "context.anchor gives unique slugs within one render and starts over in the next",
      check(render) {
        const anchors: string[] = [];
        render.registerBlock("test.heading", (_node, context) => {
          anchors.push(context.anchor("Usage"));
          return { html: "", islands: [] };
        });
        render.registerBlock("test.doc", (node, context) =>
          context.children(node),
        );
        const tree = doc([
          leaf("test.heading", "h1"),
          leaf("test.heading", "h2"),
        ]);
        render.render(tree);
        render.render(tree);
        expect(anchors[0]).not.toBe("");
        expect(anchors[1]).not.toBe(anchors[0]);
        expect(anchors[2]).toBe(anchors[0]);
      },
    },
    {
      name: "outline items from children are collected in document order",
      check(render) {
        render.registerBlock("test.heading", (node, context) => {
          const text = node.id;
          return {
            html: "",
            islands: [],
            outline: [{ anchor: context.anchor(text), depth: 2, text }],
          };
        });
        render.registerBlock("test.doc", (node, context) =>
          context.children(node),
        );
        const result = render.render(
          doc([leaf("test.heading", "One"), leaf("test.heading", "Two")]),
        );
        expect(result.outline?.map((item) => item.text)).toEqual([
          "One",
          "Two",
        ]);
      },
    },
    {
      name: "registering a theme under a taken name throws",
      check(render) {
        render.registerTheme("test.theme", { layout: () => "" });
        expect(() =>
          render.registerTheme("test.theme", { layout: () => "" }),
        ).toThrow();
      },
    },
    {
      name: "resolveTheme prefers the named theme, falls back to the first, and is undefined without themes",
      check(render) {
        expect(render.resolveTheme("test.missing")).toBeUndefined();
        render.registerTheme("test.first", { layout: () => "" });
        render.registerTheme("test.second", { layout: () => "" });
        expect(render.resolveTheme("test.second")).toBe("test.second");
        expect(render.resolveTheme("test.missing")).toBe("test.first");
        expect(render.resolveTheme(undefined)).toBe("test.first");
      },
    },
    {
      name: "renderPage without a theme returns a complete document containing the body and head",
      check(render) {
        registerBodyRenderers(render);
        const result = render.renderPage(sitePage(), {
          head: '<meta name="test-head">',
        });
        expect(result.html.toLowerCase().startsWith("<!doctype html>")).toBe(
          true,
        );
        expect(result.html).toContain("<p>body text</p>");
        expect(result.html).toContain('<meta name="test-head">');
      },
    },
    {
      name: "renderPage lays the page out with the requested theme",
      check(render) {
        registerBodyRenderers(render);
        render.registerTheme("test.other", { layout: () => "other" });
        render.registerTheme("test.theme", {
          layout: ({ page, body, head }) =>
            `<!doctype html>${head}<h1>${page.title}</h1>${body.html}`,
        });
        const result = render.renderPage(sitePage(), {
          theme: "test.theme",
          head: "<meta>",
        });
        expect(result.html).toBe(
          "<!doctype html><meta><h1>Intro</h1><p>body text</p>",
        );
      },
    },
    {
      name: "a not-found page renders a message instead of an entry body",
      check(render) {
        let body = "";
        render.registerTheme("test.theme", {
          layout: (input) => {
            body = input.body.html;
            return "";
          },
        });
        render.renderPage(
          sitePage({ kind: "not-found", entry: undefined, title: "Not found" }),
        );
        expect(body).not.toBe("");
      },
    },
    {
      name: "slot items render by ascending order, ties in registration order",
      check(render) {
        render.registerSlot("site.footer", {
          id: "c",
          order: 1,
          render: () => "c",
        });
        render.registerSlot("site.footer", { id: "a", render: () => "a" });
        render.registerSlot("site.footer", { id: "b", render: () => "b" });
        render.registerSlot("site.footer", {
          id: "z",
          order: -1,
          render: () => "z",
        });
        let footer = "";
        render.registerTheme("test.theme", {
          layout: ({ slot }) => {
            footer = slot("site.footer");
            return "";
          },
        });
        render.renderPage(sitePage());
        expect(footer).toBe("zabc");
      },
    },
    {
      name: "the site.head slot is part of the layout head",
      check(render) {
        render.registerSlot("site.head", {
          id: "meta",
          render: () => '<meta name="slot">',
        });
        let head = "";
        render.registerTheme("test.theme", {
          layout: (input) => {
            head = input.head;
            return "";
          },
        });
        render.renderPage(sitePage());
        expect(head).toContain('<meta name="slot">');
      },
    },
    {
      name: "registering a slot item id twice in one slot throws",
      check(render) {
        render.registerSlot("site.header", { id: "x", render: () => "" });
        expect(() =>
          render.registerSlot("site.header", { id: "x", render: () => "" }),
        ).toThrow();
      },
    },
    {
      name: "a page with islands carries the island manifest only for types with a module, escaped for a script element, and preloads each module once",
      check(render) {
        render.registerBlock("test.doc", (node, context) =>
          context.children(node),
        );
        render.registerBlock("test.island", (node) => ({
          html: "",
          islands: [
            { blockId: node.id, type: node.type, props: { text: "</script>" } },
          ],
        }));
        render.registerBlock("test.static", (node) => ({
          html: "",
          islands: [{ blockId: node.id, type: node.type }],
        }));
        let head = "";
        render.registerTheme("test.theme", {
          layout: (input) => {
            head = input.head;
            return "";
          },
        });
        const entry = sitePage().entry;
        if (!entry) throw new Error("expected an entry");
        const page = sitePage({
          entry: {
            ...entry,
            body: doc([
              leaf("test.island", "i1"),
              leaf("test.static", "s1"),
              leaf("test.island", "i2"),
            ]),
          },
        });
        render.renderPage(page, {
          islandUrl: (type) =>
            type === "test.island" ? "./island.js" : undefined,
        });
        const match = new RegExp(
          `<script type="application/json" id="${ISLAND_SCRIPT_ID}">(.*?)</script>`,
        ).exec(head);
        expect(match?.[1]).toBeDefined();
        expect(JSON.parse(match?.[1] ?? "")).toEqual({
          modules: { "test.island": "./island.js" },
          props: { i1: { text: "</script>" }, i2: { text: "</script>" } },
        });
        // The browser fetches island modules while it parses the page, not
        // only once the runtime has read the manifest.
        expect(head).toContain('<link rel="modulepreload" href="./island.js">');
        expect(head.match(/rel="modulepreload"/g)).toHaveLength(1);

        head = "";
        render.renderPage(page);
        expect(head).not.toContain(ISLAND_SCRIPT_ID);
      },
    },
    {
      name: "renderFiles runs every generator and skips those that return undefined",
      check(render) {
        render.registerFile("/robots.txt", ({ site }) => ({
          body: `site ${site.name}`,
          type: "text/plain; charset=utf-8",
        }));
        render.registerFile("/skip.txt", () => undefined);
        const files = render.renderFiles({
          site: sitePage().site,
          pages: [sitePage()],
        });
        expect([...files.keys()]).toEqual(["/robots.txt"]);
        expect(files.get("/robots.txt")?.body).toBe("site Site");
      },
    },
    {
      name: "registering a file path twice throws",
      check(render) {
        render.registerFile("/x.txt", () => undefined);
        expect(() => render.registerFile("/x.txt", () => undefined)).toThrow();
      },
    },
    {
      name: "disposing a theme, slot item or file removes it",
      check(render) {
        const disposeTheme = render.registerTheme("test.theme", {
          layout: () => "themed",
        });
        const disposeSlot = render.registerSlot("site.head", {
          id: "x",
          render: () => "<meta name=gone>",
        });
        const disposeFile = render.registerFile("/x.txt", () => ({
          body: "",
          type: "text/plain",
        }));
        disposeTheme();
        disposeSlot();
        disposeFile();
        expect(render.resolveTheme("test.theme")).toBeUndefined();
        const html = render.renderPage(sitePage()).html;
        expect(html).not.toBe("themed");
        expect(html).not.toContain("<meta name=gone>");
        expect(
          render.renderFiles({ site: sitePage().site, pages: [] }).size,
        ).toBe(0);
        render.registerSlot("site.head", { id: "x", render: () => "" });
      },
    },
  ],
);
