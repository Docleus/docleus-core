import { Context } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import { expect, it } from "vitest";
import { createIdentityService } from "./index.ts";

it("removes a provider when the consumer plugin that registered it unloads", async () => {
  const root = new Context();
  const storageLocation = await testStorageLocation();
  const core = await root.plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    ctx.provide("identity", createIdentityService(ctx));
  });
  const consumer = await root.plugin({
    inject: ["identity"],
    apply: (ctx: Context) => {
      ctx.identity.registerProvider("acme.sso", {
        authenticate: async () => ({ email: "a@example.com", name: "A" }),
      });
    },
  });
  expect(
    await root.identity.login("acme.sso", {}, { allowSignup: true }),
  ).toBeDefined();
  await consumer.dispose();
  expect(await root.identity.login("acme.sso", {})).toBeUndefined();
  await core.dispose();
});
