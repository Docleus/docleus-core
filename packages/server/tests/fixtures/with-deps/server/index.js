import { definePlugin } from "@docleus/sdk";
import { greeting } from "@test/greeting";

export const plugin = definePlugin({
  name: "@test/with-deps",
  inject: ["blocks", "render"],
  apply(ctx) {
    ctx.blocks.register("test.greeting", { version: 1 });
    ctx.render.registerBlock("test.greeting", () => ({
      html: `<p>${greeting}</p>`,
      islands: [],
    }));
  },
});
