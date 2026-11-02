export const plugin = {
  name: "@test/route",
  inject: ["http"],
  apply(ctx) {
    ctx.http.route(
      "GET",
      "/api/test/route",
      () => Response.json({ ok: true }),
      {
        public: true,
      },
    );
  },
};
