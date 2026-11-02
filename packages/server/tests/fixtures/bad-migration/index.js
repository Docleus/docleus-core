export const plugin = {
  name: "@test/bad-migration",
  inject: ["storage"],
  apply(ctx) {
    // Not awaited, like a plugin that migrates lazily on first use.
    void ctx.storage
      .migrate("@test/bad-migration", [
        {
          id: "0001-broken",
          async up() {
            throw new Error("broken migration");
          },
        },
      ])
      .catch(() => undefined);
  },
};
