import type {
  BlockNode,
  MarkdownCodec,
  MarkdownDocument,
  MarkdownService,
} from "@docleus/sdk";
import type { RootContent } from "mdast";
import { expect } from "vitest";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

/** Hand-written Markdown in styles a canonical printer would change. */
export const MARKDOWN_FIXTURES: readonly string[] = [
  "Setext\n======\n\n__bold__ and _em_\n*   wide  bullet\n",
  "---\n# comment\ntitle:   x\n---\n\n\nText  \r\nCRLF\r\n\r\n<!-- a -->\r\n<b>b</b>\r\n",
  "~~~\nfence\n~~~\n\n    indented\n\n> lazy\nquote\n\n[a][r]\n\n[r]: /x  'T'",
  ':::block{type="acme.unknown" k=v}\nInside.\n:::\n\n1) one\n2) two\n\n\n',
  "",
];

/** A minimal container directive node; mdast types it only with mdast-util-directive. */
interface ContainerDirective {
  readonly type: "containerDirective";
  readonly name: string;
  readonly attributes?: Record<string, string | null | undefined> | null;
  readonly children: RootContent[];
}

const CALLOUT = "test.callout";

/** Reads and writes `test.callout` blocks as `:::callout{tone=...}` directives. */
export function createCalloutCodec(): MarkdownCodec {
  return {
    name: "test.callout-codec",
    claims: ["directive:callout"],
    blockTypes: [CALLOUT],
    toBlock(node, context) {
      // Directive node types come from mdast-util-directive's augmentation, which this package does not load.
      const type: string = node.type;
      if (type !== "containerDirective") return undefined;
      const directive = node as unknown as ContainerDirective;
      if (directive.name !== "callout") return undefined;
      return {
        id: context.newId(),
        type: CALLOUT,
        v: 1,
        attrs: { tone: directive.attributes?.tone ?? "info" },
        content: context.toBlocks(directive.children),
      };
    },
    fromBlock(block, context) {
      const directive: ContainerDirective = {
        type: "containerDirective",
        name: "callout",
        attributes: { tone: String(block.attrs.tone) },
        children: context.fromBlocks(block.content ?? []),
      };
      return directive as unknown as RootContent;
    },
  };
}

/** Drops block ids, which every parse assigns afresh. */
export function withoutBlockIds(node: BlockNode): unknown {
  const { id: _id, content, ...rest } = node;
  return content ? { ...rest, content: content.map(withoutBlockIds) } : rest;
}

const paragraph = (text: string): BlockNode => ({
  id: `p-${text}`,
  type: "paragraph",
  v: 1,
  attrs: {},
  inline: [{ type: "text", text }],
});

const doc = (...content: BlockNode[]): MarkdownDocument => ({
  body: { id: "doc", type: "doc", v: 1, attrs: {}, content },
});

const callout: BlockNode = {
  id: "c",
  type: CALLOUT,
  v: 1,
  attrs: { tone: "warn" },
  content: [paragraph("Careful.")],
};

function collectIds(node: BlockNode, ids: string[] = []): string[] {
  ids.push(node.id);
  for (const child of node.content ?? []) collectIds(child, ids);
  return ids;
}

const topLevel = (document: MarkdownDocument): readonly BlockNode[] =>
  document.body.content ?? [];

const reparse = (
  markdown: MarkdownService,
  document: MarkdownDocument,
): unknown =>
  withoutBlockIds(markdown.parse(markdown.serialize(document)).body);

export const markdownConformanceSuite = defineConformanceSuite<MarkdownService>(
  "markdown",
  [
    {
      name: "an unchanged import exports byte for byte",
      check(markdown) {
        for (const source of MARKDOWN_FIXTURES) {
          expect(markdown.serialize(markdown.parse(source))).toBe(source);
        }
      },
    },
    {
      name: "editing one block reprints only that block",
      check(markdown) {
        const document = markdown.parse(
          "Keep   *this*.\n\n\nEdit me.\n\n-  keep\n",
        );
        const [first, middle, last] = topLevel(document);
        if (!first || !middle || !last)
          throw new Error("expected three blocks");
        const changed = { ...middle, inline: [{ type: "text", text: "New." }] };
        const edited = {
          ...document,
          body: { ...document.body, content: [first, changed, last] },
        };
        expect(markdown.serialize(edited)).toBe(
          "Keep   *this*.\n\n\nNew.\n\n-  keep\n",
        );
      },
    },
    {
      name: "block ids are unique within a parsed document, including nested blocks",
      check(markdown) {
        const ids = collectIds(
          markdown.parse(
            ':::block{type="acme.x"}\nA\n\nB\n:::\n\nC\n\n::block{type="acme.y"}\n',
          ).body,
        );
        expect(new Set(ids).size).toBe(ids.length);
      },
    },
    {
      name: "core marks survive a round trip without a source map",
      check(markdown) {
        const document = doc({
          ...paragraph(""),
          inline: [
            { type: "text", text: "a", marks: [{ type: "bold" }] },
            {
              type: "text",
              text: "b",
              marks: [{ type: "italic" }, { type: "code" }],
            },
            {
              type: "text",
              text: "c",
              marks: [{ type: "link", attrs: { href: "/x" } }],
            },
            { type: "text", text: "d", marks: [{ type: "strike" }] },
          ],
        });
        expect(reparse(markdown, document)).toEqual(
          withoutBlockIds(document.body),
        );
      },
    },
    {
      name: "Markdown no codec claims becomes a raw block that keeps its source",
      check(markdown) {
        const [block] = topLevel(markdown.parse("#  Heading  #\n"));
        expect(block?.type).toBe("raw");
        expect(block?.attrs.source).toBe("#  Heading  #");
      },
    },
    {
      name: "a block type no codec writes exports as a generic tag and imports back unchanged",
      check(markdown) {
        const unknown: BlockNode = {
          id: "u",
          type: "acme.unknown",
          v: 3,
          attrs: { title: "T", nested: { list: [1, "two", null] } },
          inline: [
            { type: "text", text: "label", marks: [{ type: "acme.mark" }] },
          ],
          content: [paragraph("Body.")],
        };
        const printed = markdown.serialize(doc(unknown));
        expect(printed).toContain('type="acme.unknown"');
        expect(reparse(markdown, doc(unknown))).toEqual(
          withoutBlockIds(doc(unknown).body),
        );
      },
    },
    {
      name: "a registered codec claims its syntax on import and writes it on export",
      check(markdown) {
        markdown.register(createCalloutCodec());
        const [block] = topLevel(
          markdown.parse(':::callout{tone="warn"}\nCareful.\n:::\n'),
        );
        expect(block && withoutBlockIds(block)).toEqual(
          withoutBlockIds(callout),
        );
        expect(markdown.serialize(doc(callout))).toBe(
          ':::callout{tone="warn"}\nCareful.\n:::\n',
        );
      },
    },
    {
      name: "after a codec is unregistered its blocks export as generic tags, and re-registering restores them on import",
      check(markdown) {
        const unregister = markdown.register(createCalloutCodec());
        unregister();
        const printed = markdown.serialize(doc(callout));
        expect(printed).toContain(`type="${CALLOUT}"`);
        markdown.register(createCalloutCodec());
        const [block] = topLevel(markdown.parse(printed));
        expect(block && withoutBlockIds(block)).toEqual(
          withoutBlockIds(callout),
        );
        expect(markdown.serialize(markdown.parse(printed))).toBe(printed);
        expect(markdown.serialize(doc(callout))).toBe(
          ':::callout{tone="warn"}\nCareful.\n:::\n',
        );
      },
    },
    {
      name: "registering a claim another codec holds throws",
      async check(markdown) {
        markdown.register(createCalloutCodec());
        await expectToReject(() =>
          markdown.register({
            ...createCalloutCodec(),
            name: "test.other-codec",
          }),
        );
      },
    },
    {
      name: "frontmatter is split from the body and kept verbatim until it changes",
      check(markdown) {
        const source = "---\ntitle:   T # note\n---\nBody.\n";
        const document = markdown.parse(source);
        expect(document.frontmatter).toEqual({ title: "T" });
        expect(markdown.serialize(document)).toBe(source);
        expect(
          markdown.serialize({ ...document, frontmatter: { title: "U" } }),
        ).toBe("---\ntitle: U\n---\nBody.\n");
      },
    },
  ],
);
