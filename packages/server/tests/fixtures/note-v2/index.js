export const plugin = {
  name: "@test/note-v2",
  inject: ["blocks"],
  apply(ctx) {
    ctx.blocks.register("test.note", {
      version: 2,
      migrations: { 1: (node) => ({ ...node, v: 2 }) },
    });
  },
};
