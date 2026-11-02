import { definePlugin, escapeHtml } from "@docleus/sdk";

export const plugin = definePlugin({
  name: "@test/installable",
  inject: ["blocks", "render"],
  apply(ctx) {
    ctx.blocks.register("test.stamp", { version: 1 });
    ctx.render.registerBlock("test.stamp", (node) => ({
      html: `<p class="test-stamp">${escapeHtml(String(node.attrs?.label ?? ""))}</p>`,
      islands: [],
    }));
  },
});
