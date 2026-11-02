import { Context } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import { expect, it } from "vitest";
import { createJobsService } from "./index.ts";

it("removes a handler when the consumer plugin that registered it unloads", async () => {
  const root = new Context();
  const storageLocation = await testStorageLocation();
  const core = await root.plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    ctx.provide("jobs", createJobsService(ctx));
  });
  const consumer = await root.plugin({
    inject: ["jobs"],
    apply: (ctx: Context) => {
      ctx.jobs.handle("acme.sync", async () => {});
    },
  });
  await consumer.dispose();
  expect(() => root.jobs.handle("acme.sync", async () => {})).not.toThrow();
  await core.dispose();
});
