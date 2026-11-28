import { Context, type BlockNode, type MarkdownCodec } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createMarkdownService } from "./index.ts";

const LIST_CODEC: MarkdownCodec = {
  name: "test.lists",
  claims: ["list"],
  blockTypes: ["test.list"],
  toBlock(node, context) {
    if (node.type !== "list") return undefined;
    return {
      id: context.newId(),
      type: "test.list",
      v: 1,
      attrs: { ordered: node.ordered ?? false, start: node.start ?? null },
      content: node.children.flatMap((item) => context.toBlocks(item.children)),
    };
  },
  fromBlock(block, context) {
    return {
      type: "list",
      ordered: block.attrs.ordered === true,
      start: typeof block.attrs.start === "number" ? block.attrs.start : null,
      spread: false,
      children: (block.content ?? []).map((paragraph) => ({
        type: "listItem",
        spread: false,
        children: context
          .fromBlocks([paragraph])
          .filter((child) => child.type === "paragraph"),
      })),
    };
  },
};

function changed(block: BlockNode): BlockNode {
  return {
    ...block,
    content: block.content?.map((paragraph) => ({
      ...paragraph,
      inline: [{ type: "text", text: "Edited" }],
    })),
  };
}

describe("separate list boundaries", () => {
  const markdown = createMarkdownService(new Context());
  markdown.register(LIST_CODEC);

  it.each([
    "1. First\n\n9) Ninth\n",
    "* First\n\n- Second\n",
    "1. First\n\n9) Ninth\n\n3. Third\n",
  ])("preserves lists when either neighbor is edited: %s", (source) => {
    const document = markdown.parse(source);
    const blocks = document.body.content ?? [];
    expect(markdown.serialize(document)).toBe(source);
    for (const editedIndex of [-1, ...blocks.map((_block, index) => index)]) {
      const edited = {
        ...document,
        body: {
          ...document.body,
          content: blocks.map((block, index) =>
            editedIndex === -1 || index === editedIndex
              ? changed(block)
              : block,
          ),
        },
      };
      const reparsed = markdown.parse(markdown.serialize(edited));
      expect(reparsed.body.content?.map((block) => block.attrs)).toEqual(
        blocks.map((block) => block.attrs),
      );
      expect(reparsed.body.content?.map((block) => block.type)).toEqual(
        blocks.map((block) => block.type),
      );
    }
  });
});
