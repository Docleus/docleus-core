import {
  Context,
  type BlockNode,
  type InlineNode,
  type Mark,
} from "@docleus/sdk";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeInline } from "./inline.ts";
import { createMarkdownService } from "./index.ts";

const markdown = createMarkdownService(new Context());

/** Printable text, weighted towards characters Markdown gives meaning to. */
const SPECIAL = [..."*_`~[]()<>#!:\\&\"'{}|-+.=$%^@/?;,"];
const LETTERS = [..."abcxyzABC019 "];
const textChar = fc.constantFrom(
  ...SPECIAL,
  ...LETTERS.filter((c) => c !== " "),
);
const word = fc.string({ unit: textChar, minLength: 1, maxLength: 6 });
const words = fc
  .array(word, { minLength: 1, maxLength: 3 })
  .map((list) => list.join(" "));

const valueChar = fc.constantFrom(...SPECIAL, ...LETTERS, "\n", "é", "中");
const attrString = fc.string({ unit: valueChar, maxLength: 12 });
const attrValue = fc.oneof(
  attrString,
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(attrString, { maxLength: 2 }),
);
const attrKey = fc.constantFrom(
  "tone",
  "a-b",
  "x_y",
  "id",
  "two words",
  "attrs",
  "type",
  "n",
);
const attrs = fc.dictionary(attrKey, attrValue, { maxKeys: 3 });

const coreMark = fc.oneof(
  fc.constantFrom<Mark>(
    { type: "bold" },
    { type: "italic" },
    { type: "strike" },
    { type: "code" },
  ),
  fc
    .record({
      href: fc.constantFrom(
        "https://example.com/a",
        "/docs/b.md",
        "#c",
        "mailto:x@y.z",
      ),
      title: fc.option(words, { nil: undefined }),
    })
    .map(({ href, title }): Mark => ({
      type: "link",
      attrs: title === undefined ? { href } : { href, title },
    })),
);

const textNode = fc
  .record({
    text: words,
    marks: fc.uniqueArray(coreMark, { maxLength: 3, selector: (m) => m.type }),
  })
  .map(({ text, marks }): InlineNode =>
    marks.length > 0 ? { type: "text", text, marks } : { type: "text", text },
  );
const unknownMarkText = fc
  .record({ text: words, color: attrString })
  .map(({ text, color }): InlineNode => ({
    type: "text",
    text,
    marks: [{ type: "bold" }, { type: "acme.highlight", attrs: { color } }],
  }));
// Each is one node as the parser produces it: `<kbd>x</kbd>` would be two.
const rawInline = fc
  .constantFrom("<kbd>", "![alt](img.png)")
  .map((source): InlineNode => ({ type: "raw", attrs: { source } }));

const { inline } = fc.letrec<{ inline: InlineNode[]; node: InlineNode }>(
  (tie) => ({
    inline: fc.array(tie("node"), { minLength: 1, maxLength: 4 }),
    node: fc.oneof(
      { weight: 6, arbitrary: textNode },
      { weight: 1, arbitrary: unknownMarkText },
      { weight: 1, arbitrary: rawInline },
      {
        weight: 1,
        arbitrary: fc
          .record({
            attrs,
            content: fc.option(fc.array(textNode, { maxLength: 2 }), {
              nil: undefined,
            }),
          })
          .map(({ attrs: a, content }): InlineNode => ({
            type: "acme.mention",
            ...(Object.keys(a).length > 0 && { attrs: a }),
            ...(content && { content }),
          })),
      },
    ),
  }),
);

// A line holding nothing but an HTML tag is an HTML block, not a paragraph.
const isLoneHtml = (nodes: readonly InlineNode[]): boolean =>
  nodes.length === 1 &&
  nodes[0]?.type === "raw" &&
  String(nodes[0].attrs?.source).startsWith("<");

const paragraph = inline
  .filter((nodes) => !isLoneHtml(nodes))
  .map((nodes): BlockNode => ({
    id: "x",
    type: "paragraph",
    v: 1,
    attrs: {},
    inline: nodes,
  }));
const raw = fc
  .constantFrom(
    "# Heading",
    "```js\nconst a = 1;\n```",
    "- one\n- two",
    "> quoted",
    "***",
    "<div>x</div>",
  )
  .map((source): BlockNode => ({
    id: "x",
    type: "raw",
    v: 1,
    attrs: { source },
  }));

const { block } = fc.letrec<{ block: BlockNode; unknown: BlockNode }>(
  (tie) => ({
    block: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      { weight: 4, arbitrary: paragraph },
      { weight: 1, arbitrary: raw },
      { weight: 2, arbitrary: tie("unknown") },
    ),
    unknown: fc
      .record({
        type: fc.constantFrom("acme.callout", "x.y-z"),
        v: fc.integer({ min: 1, max: 3 }),
        attrs,
        content: fc.option(fc.array(tie("block"), { maxLength: 2 }), {
          nil: undefined,
        }),
        inline: fc.option(fc.oneof(inline, fc.constant([])), {
          nil: undefined,
        }),
      })
      .map(({ type, v, attrs: a, content, inline: label }): BlockNode => ({
        id: "x",
        type,
        v,
        attrs: a,
        ...(content && { content }),
        ...(label && { inline: label }),
      })),
  }),
);

/**
 * Two raw lists with the same bullet next to each other re-parse as one
 * list: their boundary is not in the tree. Imported documents never contain
 * this, because the parser already joined them.
 */
function hasAdjacentRawLists(blocks: readonly BlockNode[]): boolean {
  return blocks.some(
    (current, i) =>
      (current.type === "raw" &&
        String(current.attrs.source).startsWith("- ") &&
        blocks[i + 1]?.type === "raw" &&
        String(blocks[i + 1]?.attrs.source).startsWith("- ")) ||
      hasAdjacentRawLists(current.content ?? []),
  );
}

const doc = fc
  .array(block, { maxLength: 5 })
  .filter((content) => !hasAdjacentRawLists(content))
  .map((content): BlockNode => ({
    id: "x",
    type: "doc",
    v: 1,
    attrs: {},
    content,
  }));

/** What the codec promises to keep: everything except ids, with inline content in canonical form. */
function comparable(node: BlockNode): unknown {
  return {
    type: node.type,
    v: node.v,
    attrs: node.attrs,
    ...(node.content && { content: node.content.map(comparable) }),
    ...(node.inline && { inline: normalizeInline(node.inline) }),
  };
}

// ROUND_TRIP_RUNS raises the run count for a deeper local search.
describe("rule 1: tree -> Markdown -> tree", { timeout: 120_000 }, () => {
  it("keeps content and attrs for generated documents", () => {
    fc.assert(
      fc.property(doc, (body) => {
        const printed = markdown.serialize({ body });
        const parsed = markdown.parse(printed);
        expect(comparable(parsed.body)).toEqual(comparable(body));
      }),
      { numRuns: Number(process.env.ROUND_TRIP_RUNS ?? 3000) },
    );
  });

  it("prints paragraphs as Markdown, not the generic-tag fallback, for nearly every input", () => {
    let fallbacks = 0;
    const runs = 2000;
    fc.assert(
      fc.property(paragraph, (generated) => {
        const printed = markdown.serialize({
          body: { id: "d", type: "doc", v: 1, attrs: {}, content: [generated] },
        });
        if (printed.startsWith('::block{type="paragraph"')) fallbacks += 1;
      }),
      { numRuns: runs },
    );
    // The fallback covers rare text with no Markdown form; a printer bug
    // that pushed common input into it would show up here.
    expect(fallbacks / runs).toBeLessThan(0.01);
  });

  it.each(["<%@a>", "<a@b.c>", "x <a.b@c> y", "<https://a.b>"])(
    "keeps the text %s, which reads as an autolink unless escaped",
    (text) => {
      const body: BlockNode = {
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
            inline: [{ type: "text", text }],
          },
        ],
      };
      const parsed = markdown.parse(markdown.serialize({ body }));
      expect(comparable(parsed.body)).toEqual(comparable(body));
    },
  );

  it("keeps frontmatter", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom("title", "order", "tags"), attrValue, {
          minKeys: 1,
        }),
        doc,
        (frontmatter, body) => {
          const parsed = markdown.parse(
            markdown.serialize({ body, frontmatter }),
          );
          expect(parsed.frontmatter).toEqual(frontmatter);
          expect(comparable(parsed.body)).toEqual(comparable(body));
        },
      ),
      { numRuns: 500 },
    );
  });
});
