import { Context } from "@docleus/kernel";
import { expect, it } from "vitest";
import { createRenderService } from "./index.ts";

it("unregisters a renderer when the consumer plugin that registered it unloads", async () => {
  const root = new Context();
  const core = await root.plugin((ctx: Context) => {
    ctx.provide("render", createRenderService(ctx));
  });
  const consumer = await root.plugin({
    inject: ["render"],
    apply: (ctx: Context) => {
      ctx.render.registerBlock("acme.callout", () => ({
        html: "<aside></aside>",
        islands: [],
      }));
    },
  });
  const node = { id: "a", type: "acme.callout", v: 1, attrs: {} };
  expect(root.render.render(node).html).toBe("<aside></aside>");
  await consumer.dispose();
  expect(root.render.render(node).html).toContain("data-unknown-block");
  await core.dispose();
});
