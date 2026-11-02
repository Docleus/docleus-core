import { Context } from "@docleus/kernel";
import { createAuthzService } from "@docleus/core-authz";
import { createIdentityService } from "@docleus/core-identity";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import { expect, it } from "vitest";
import { createHttpService } from "./index.ts";

it("removes a route when the consumer plugin that registered it unloads", async () => {
  const root = new Context();
  const storageLocation = await testStorageLocation();
  const core = await root.plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    ctx.provide("identity", createIdentityService(ctx));
    ctx.provide("authz", createAuthzService(ctx));
    ctx.provide("http", createHttpService(ctx));
  });
  const consumer = await root.plugin({
    inject: ["http"],
    apply: (ctx: Context) => {
      ctx.http.route("GET", "/x", () => new Response("x"), { public: true });
    },
  });
  const get = () => root.http.fetch(new Request("http://localhost/x"));
  expect((await get()).status).toBe(200);

  await consumer.dispose();

  expect((await get()).status).toBe(404);
  await core.dispose();
});
