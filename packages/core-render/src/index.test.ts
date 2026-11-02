import { Context } from "@docleus/kernel";
import {
  renderConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import type { BlockNode, DispatchScope, SitePage } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createRenderService } from "./index.ts";

runConformanceSuite(renderConformanceSuite, () =>
  createRenderService(new Context()),
);

describe("createRenderService", () => {
  it("undoes registration when the owning plugin is disposed", async () => {
    const root = new Context();
    let render!: ReturnType<typeof createRenderService>;
    const fiber = await root.plugin((ctx: Context) => {
      render = createRenderService(ctx);
      render.registerBlock("test.plugin-owned", () => ({
        html: "<p>x</p>",
        islands: [],
      }));
    });
    expect(
      render.render({ id: "a", type: "test.plugin-owned", v: 1, attrs: {} })
        .html,
    ).toBe("<p>x</p>");

    await fiber.dispose();

    expect(
      render.render({ id: "a", type: "test.plugin-owned", v: 1, attrs: {} })
        .html,
    ).not.toBe("<p>x</p>");
  });
});

const sitePage = (body: BlockNode): SitePage => ({
  kind: "page",
  site: { id: "s1", name: "Site", settings: undefined },
  space: { id: "sp1", orgId: "o1", slug: "docs", name: "Docs" },
  revision: "r1",
  entry: {
    id: "e1",
    type: "page",
    title: "Intro",
    parent: undefined,
    order: 0,
    fields: {},
    body,
  },
  path: "/",
  title: "Intro",
  nav: [],
  prev: undefined,
  next: undefined,
  url: (path) => `.${path}`,
  asset: (plugin, file) => `./${plugin}/${file}`,
});
const callout: BlockNode = { id: "a", type: "acme.callout", v: 1, attrs: {} };
const only = (...plugins: string[]): DispatchScope => ({
  allows: (plugin) => plugins.includes(plugin),
});

async function setupScoped() {
  const root = new Context();
  await root.plugin((ctx: Context) => {
    ctx.provide("render", createRenderService(ctx));
  });
  await root.plugin({
    name: "acme.blocks",
    inject: ["render"],
    apply: (ctx: Context) => {
      ctx.render.registerBlock("acme.callout", () => ({
        html: "<aside></aside>",
        islands: [],
      }));
      ctx.render.registerSlot("site.head", {
        id: "acme",
        render: () => '<meta name="acme">',
      });
      ctx.render.registerFile("/acme.txt", () => ({
        body: "acme",
        type: "text/plain",
      }));
    },
  });
  await root.plugin({
    name: "acme.theme",
    inject: ["render"],
    apply: (ctx: Context) => {
      ctx.render.registerTheme("acme.theme", {
        layout: ({ body, head }) => `<!doctype html>${head}${body.html}`,
      });
      ctx.on("render/page", (_input, next) => `<!-- wrapped -->${next()}`);
    },
  });
  return root;
}

describe("scoped rendering", () => {
  it("renders blocks of a plugin the scope does not allow as placeholders", async () => {
    const root = await setupScoped();
    expect(root.render.render(callout, { scope: only() }).html).toContain(
      "data-unknown-block",
    );
    expect(
      root.render.render(callout, { scope: only("acme.blocks") }).html,
    ).toBe("<aside></aside>");
  });

  it("skips themes, slots, files and render/page hooks of disallowed plugins", async () => {
    const root = await setupScoped();
    const all = root.render.renderPage(sitePage(callout), {
      theme: "acme.theme",
    });
    expect(all.html).toBe(
      '<!-- wrapped --><!doctype html><meta name="acme"><aside></aside>',
    );

    const scope = only();
    expect(root.render.resolveTheme("acme.theme", { scope })).toBeUndefined();
    const none = root.render.renderPage(sitePage(callout), {
      theme: "acme.theme",
      scope,
    });
    expect(none.html).not.toContain("wrapped");
    expect(none.html).not.toContain('<meta name="acme">');
    expect(none.html).toContain("data-unknown-block");
    expect(
      root.render.renderFiles(
        { site: sitePage(callout).site, pages: [] },
        { scope },
      ).size,
    ).toBe(0);
  });
});
