export const said = [];

export const plugin = {
  name: "test-consumer",
  inject: ["test.hello"],
  apply(ctx) {
    said.push(ctx.get("test.hello").say());
    ctx.on("test/fixture", () => undefined);
  },
};
