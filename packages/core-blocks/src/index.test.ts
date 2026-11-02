import { Context } from "@docleus/kernel";
import {
  blocksConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import { describe, expect, it } from "vitest";
import { createBlocksService } from "./index.ts";

runConformanceSuite(blocksConformanceSuite, () =>
  createBlocksService(new Context()),
);

describe("createBlocksService", () => {
  it("undoes registration when the owning plugin is disposed", async () => {
    const root = new Context();
    let blocks!: ReturnType<typeof createBlocksService>;
    const fiber = await root.plugin((ctx: Context) => {
      blocks = createBlocksService(ctx);
      blocks.register("test.plugin-owned", { version: 1 });
    });
    expect(blocks.isKnown("test.plugin-owned")).toBe(true);

    await fiber.dispose();

    expect(blocks.isKnown("test.plugin-owned")).toBe(false);
  });

  it("does not mutate the node passed to read", () => {
    const blocks = createBlocksService(new Context());
    blocks.register("test.immutable", {
      version: 2,
      migrations: { 1: (node) => ({ ...node, v: 2 }) },
    });
    const node = { id: "a", type: "test.immutable", v: 1, attrs: {} };
    const before = structuredClone(node);
    blocks.read(node);
    expect(node).toEqual(before);
  });

  it("collects searchable text, one line per text-bearing block", () => {
    const blocks = createBlocksService(new Context());
    blocks.register("test.code", {
      version: 1,
      text: (node) => String(node.attrs.code),
    });
    const doc = {
      id: "d",
      type: "doc",
      v: 1,
      attrs: {},
      content: [
        {
          id: "p",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world", marks: [{ type: "bold" }] },
          ],
        },
        { id: "c", type: "test.code", v: 1, attrs: { code: "let x = 1" } },
        { id: "r", type: "raw", v: 1, attrs: { source: "<b>raw</b>" } },
        {
          id: "q",
          type: "test.unknown",
          v: 1,
          attrs: {},
          content: [
            {
              id: "n",
              type: "paragraph",
              v: 1,
              attrs: {},
              inline: [{ type: "text", text: "nested" }],
            },
          ],
        },
        { id: "e", type: "paragraph", v: 1, attrs: {}, inline: [] },
      ],
    };
    expect(blocks.text(doc)).toBe("Hello world\nlet x = 1\n<b>raw</b>\nnested");
  });
});
