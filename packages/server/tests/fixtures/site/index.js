export const plugin = {
  name: "@test/site",
  inject: ["render"],
  apply(ctx) {
    ctx.render.registerBlock("test.counter", (node) => ({
      html: `<div data-island="test.counter" data-block="${node.id}">0</div>`,
      islands: [
        { blockId: node.id, type: "test.counter", props: { start: 0 } },
      ],
    }));
    ctx.render.registerTheme("@test/site", {
      layout: ({ page, head, body }) =>
        `<!doctype html><html><head>${head}<link rel="stylesheet" href="${page.asset("@test/site", "public/site/style.css")}"></head><body data-theme="test-site"><h1>${page.title}</h1>${body.html}</body></html>`,
    });
  },
};
