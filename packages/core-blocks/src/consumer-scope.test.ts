import { Context } from "@docleus/kernel";
import { expect, it } from "vitest";
import { createBlocksService } from "./index.ts";

it("unregisters a block type when the consumer plugin that registered it unloads", async () => {
  const root = new Context();
  const core = await root.plugin((ctx: Context) => {
    ctx.provide("blocks", createBlocksService(ctx));
  });
  const consumer = await root.plugin({
    inject: ["blocks"],
    apply: (ctx: Context) => {
      ctx.blocks.register("acme.callout", { version: 1 });
    },
  });
  expect(root.blocks.isKnown("acme.callout")).toBe(true);
  await consumer.dispose();
  expect(root.blocks.isKnown("acme.callout")).toBe(false);
  await core.dispose();
});
