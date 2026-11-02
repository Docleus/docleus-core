import { createElement } from "react";
import { definePlugin } from "@docleus/sdk";

const TYPE = "test.stamp";

export const plugin = definePlugin({
  name: "@test/installable",
  inject: ["editor"],
  apply(ctx) {
    ctx.editor.registerBlock({
      type: TYPE,
      version: 1,
      content: "atom",
      attrs: { label: "Installed stamp" },
      view: ({ attrs }) =>
        createElement("p", { className: "test-stamp" }, String(attrs.label)),
    });
    ctx.editor.registerSlashItem({
      id: TYPE,
      label: "Stamp",
      keywords: ["stamp"],
      run(editor) {
        editor.insertBlock(TYPE, { label: "Installed stamp" });
      },
    });
  },
});
