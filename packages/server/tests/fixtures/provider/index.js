export const plugin = {
  name: "test-provider",
  provide: ["test.hello"],
  apply(ctx, config) {
    ctx.provide("test.hello", {
      say: () => `hello ${config?.who ?? "nobody"}`,
    });
    ctx.on("test/fixture", () => undefined);
  },
};
