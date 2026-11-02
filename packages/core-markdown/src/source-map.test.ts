import { readFileSync } from "node:fs";
import { Context, type BlockNode, type MarkdownDocument } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createMarkdownService } from "./index.ts";

const markdown = createMarkdownService(new Context());
const fixture = (name: string): string =>
  readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");

function edit(
  document: MarkdownDocument,
  index: number,
  change: (block: BlockNode) => BlockNode,
): MarkdownDocument {
  const content = [...(document.body.content ?? [])];
  const block = content[index];
  if (!block) throw new Error(`no block at ${index}`);
  content[index] = change(block);
  return { ...document, body: { ...document.body, content } };
}

describe("rule 2: unchanged blocks keep their source", () => {
  it.each([
    ["mixed-style.md", fixture("mixed-style.md")],
    ["without a final newline", fixture("mixed-style.md").trimEnd()],
    ["CRLF line endings", fixture("mixed-style.md").replaceAll("\n", "\r\n")],
    ["leading blank lines and no frontmatter", "\n\n\nText.\n\n\n"],
    ["only frontmatter", "---\na: 1\n---\n"],
    ["an empty file", ""],
    ["whitespace only", "  \n\n"],
  ])("exports %s byte for byte", (_name, source) => {
    expect(markdown.serialize(markdown.parse(source))).toBe(source);
  });

  it("reprints only the edited block", () => {
    const source = "First   paragraph.\n\n\n*  odd   list*\n\nLast  one.\n";
    const document = markdown.parse(source);
    const edited = edit(document, 0, (block) => ({
      ...block,
      inline: [{ type: "text", text: "Changed." }],
    }));
    expect(markdown.serialize(edited)).toBe(
      "Changed.\n\n\n*  odd   list*\n\nLast  one.\n",
    );
  });

  it("keeps blocks apart after reordering, even one that had no blank line before it", () => {
    const document = markdown.parse("Intro.\n- item\n\nOutro.\n");
    const [intro, list, outro] = document.body.content ?? [];
    if (!intro || !list || !outro) throw new Error("expected three blocks");
    const reordered: MarkdownDocument = {
      ...document,
      body: { ...document.body, content: [outro, list, intro] },
    };
    const reparsed = markdown.parse(markdown.serialize(reordered));
    expect(reparsed.body.content?.map((block) => block.type)).toEqual([
      "paragraph",
      "raw",
      "paragraph",
    ]);
  });

  it("adds a blank line when a deletion removes the block an unchanged one was joined to", () => {
    const document = markdown.parse("A.\n\n<!-- x -->\n<div>y</div>\n");
    const [first, comment, div] = document.body.content ?? [];
    if (!first || !comment || !div) throw new Error("expected three blocks");
    expect(markdown.serialize(document)).toBe(
      "A.\n\n<!-- x -->\n<div>y</div>\n",
    );
    const deleted = {
      ...document,
      body: { ...document.body, content: [first, div] },
    };
    expect(markdown.serialize(deleted)).toBe("A.\n\n<div>y</div>\n");
  });

  it("keeps the original frontmatter text until its data changes", () => {
    const source = "---\ntitle:   Kept   # comment\n---\nBody.\n";
    const document = markdown.parse(source);
    expect(markdown.serialize(document)).toBe(source);
    const changed = { ...document, frontmatter: { title: "New" } };
    expect(markdown.serialize(changed)).toBe("---\ntitle: New\n---\nBody.\n");
  });

  it("prints new blocks canonically, separated by a blank line", () => {
    const document = markdown.parse("One.\n");
    const content = [
      ...(document.body.content ?? []),
      {
        id: "new",
        type: "paragraph",
        v: 1,
        attrs: {},
        inline: [{ type: "text", text: "Two." }],
      },
    ];
    expect(
      markdown.serialize({ ...document, body: { ...document.body, content } }),
    ).toBe("One.\n\nTwo.\n");
  });
});
