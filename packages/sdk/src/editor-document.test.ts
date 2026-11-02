import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PASSTHROUGH_BLOCK,
  PASSTHROUGH_INLINE,
  blockTypeOf,
  editorNodeName,
  fromEditorDocument,
  toEditorDocument,
  type EditorJsonNode,
  type EditorSchemaInfo,
} from "./editor-document.ts";
import type { BlockNode, InlineNode, Mark } from "./services/blocks.ts";

const doc = (content: BlockNode[]): BlockNode => ({
  id: "root",
  type: "doc",
  v: 1,
  attrs: {},
  content,
});
const paragraph = (id: string, inline: InlineNode[]): BlockNode => ({
  id,
  type: "paragraph",
  v: 1,
  attrs: {},
  inline,
});

const lookup =
  (table: Record<string, string[]>) =>
  (name: string): ReadonlySet<string> | undefined => {
    const attrs = table[name];
    return attrs && new Set(attrs);
  };

function schemaOf(
  nodes: Record<string, string[]>,
  marks: Record<string, string[]> = {},
): EditorSchemaInfo {
  return { nodeAttrs: lookup(nodes), markAttrs: lookup(marks) };
}

const node = (
  type: string,
  id: string | null,
  content?: EditorJsonNode[],
  attrs: Record<string, unknown> = {},
): EditorJsonNode => ({
  type,
  attrs: { ...attrs, blockId: id, blockVersion: 1 },
  ...(content && { content }),
});

describe("editor node names", () => {
  it.each([
    ["paragraph", "paragraph"],
    ["commonmark.list-item", "commonmark_list__item"],
    ["acme.api-endpoint.v2", "acme_api__endpoint_v2"],
  ])("encodes %s as %s and back", (type, name) => {
    expect(editorNodeName(type)).toBe(name);
    expect(blockTypeOf(name)).toBe(type);
  });

  it.each(["Acme.x", "acme..x", "acme.-x", "acme_x", "acme.x-", ""])(
    "rejects the type %j",
    (type) => {
      expect(() => editorNodeName(type)).toThrow(
        expect.objectContaining({ code: "editor/invalid-type" }),
      );
    },
  );

  it.each(["passthroughBlock", "a___b", "a_", "_a", "a__", "1a"])(
    "rejects the name %j",
    (name) => {
      expect(() => blockTypeOf(name)).toThrow(
        expect.objectContaining({ code: "editor/invalid-name" }),
      );
    },
  );

  it("is a bijection on valid types", () => {
    const segment = fc.stringMatching(
      /^[a-z][a-z0-9]{0,3}(?:-[a-z0-9]{1,3}){0,2}$/,
    );
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 3 }),
        (parts) => {
          const type = parts.join(".");
          expect(blockTypeOf(editorNodeName(type))).toBe(type);
        },
      ),
    );
  });
});

describe("toEditorDocument", () => {
  it("puts ids and versions in node attrs and keeps marks", () => {
    const json = toEditorDocument(
      doc([
        paragraph("p1", [
          { type: "text", text: "a" },
          {
            type: "text",
            text: "b",
            marks: [{ type: "link", attrs: { href: "/x" } }, { type: "bold" }],
          },
        ]),
      ]),
    );
    expect(json).toEqual({
      type: "doc",
      attrs: { blockId: "root", blockVersion: 1 },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "p1", blockVersion: 1 },
          content: [
            { type: "text", text: "a" },
            {
              type: "text",
              text: "b",
              marks: [
                { type: "link", attrs: { href: "/x" } },
                { type: "bold" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("keeps what the schema cannot show as passthrough nodes", () => {
    const unknown: BlockNode = {
      id: "u",
      type: "acme.widget",
      v: 3,
      attrs: { size: 2 },
      content: [paragraph("inner", [{ type: "text", text: "x" }])],
    };
    const image: InlineNode = {
      type: "acme.image",
      attrs: { src: "a.png" },
    };
    const highlighted: InlineNode = {
      type: "text",
      text: "y",
      marks: [{ type: "acme.highlight" }],
    };
    const source = doc([unknown, paragraph("p", [image, highlighted])]);
    const json = toEditorDocument(source, schemaOf({ paragraph: [] }));
    expect(json.content?.[0]).toEqual({
      type: PASSTHROUGH_BLOCK,
      attrs: { blockId: "u", blockVersion: 3, block: unknown },
    });
    expect(json.content?.[1]?.content).toEqual([
      { type: PASSTHROUGH_INLINE, attrs: { inline: image } },
      { type: PASSTHROUGH_INLINE, attrs: { inline: highlighted } },
    ]);
    expect(fromEditorDocument(json)).toEqual(source);
  });

  it("keeps a known block whose attrs the schema lacks as passthrough", () => {
    const heading: BlockNode = {
      id: "h",
      type: "acme.heading",
      v: 2,
      attrs: { depth: 2, anchor: "x" },
      inline: [{ type: "text", text: "t" }],
    };
    const json = toEditorDocument(
      doc([heading]),
      schemaOf({ acme_heading: ["depth"] }),
    );
    expect(json.content?.[0]?.type).toBe(PASSTHROUGH_BLOCK);
  });

  it("rejects a root that is not a doc", () => {
    expect(() => toEditorDocument(paragraph("p", []))).toThrow(
      expect.objectContaining({ code: "editor/invalid-document" }),
    );
  });
});

describe("fromEditorDocument", () => {
  it("drops null attrs of marks and inline nodes but keeps block attrs", () => {
    const json = node("doc", "root", [
      node(
        "acme_item",
        "i",
        [
          {
            type: "text",
            text: "a",
            marks: [{ type: "link", attrs: { href: "/a", title: null } }],
          },
          { type: "acme_icon", attrs: { name: "x", size: null } },
        ],
        { checked: null },
      ),
    ]);
    expect(fromEditorDocument(json)).toEqual(
      doc([
        {
          id: "i",
          type: "acme.item",
          v: 1,
          attrs: { checked: null },
          inline: [
            {
              type: "text",
              text: "a",
              marks: [{ type: "link", attrs: { href: "/a" } }],
            },
            { type: "acme.icon", attrs: { name: "x" } },
          ],
        },
      ]),
    );
  });

  it("takes the id of a passthrough node over the one it holds", () => {
    const held = paragraph("old", [{ type: "text", text: "x" }]);
    const json = node("doc", "root", [
      { type: PASSTHROUGH_BLOCK, attrs: { blockId: "new", block: held } },
    ]);
    expect(fromEditorDocument(json).content).toEqual([{ ...held, id: "new" }]);
  });

  it.each<[string, unknown]>([
    ["a non-object", "doc"],
    ["a root that is not a doc", node("paragraph", "p")],
    ["a block without an id", node("doc", "root", [node("paragraph", null)])],
    [
      "a duplicate id",
      node("doc", "root", [node("paragraph", "p"), node("paragraph", "p")]),
    ],
    [
      "a duplicate id inside a passthrough block",
      node("doc", "root", [
        node("paragraph", "p"),
        {
          type: PASSTHROUGH_BLOCK,
          attrs: {
            blockId: "q",
            block: doc([paragraph("p", [])]),
          },
        },
      ]),
    ],
    [
      "mixed blocks and inline content",
      node("doc", "root", [
        node("acme_box", "b", [
          node("paragraph", "p"),
          { type: "text", text: "x" },
        ]),
      ]),
    ],
    [
      "a block without a version",
      node("doc", "root", [
        { type: "paragraph", attrs: { blockId: "p", blockVersion: null } },
      ]),
    ],
    ["a node name that is no type", node("doc", "root", [node("Bad", "p")])],
    [
      "a bad passthrough block",
      node("doc", "root", [
        { type: PASSTHROUGH_BLOCK, attrs: { blockId: "p", block: { id: 1 } } },
      ]),
    ],
  ])("rejects %s", (_name, json) => {
    expect(() => fromEditorDocument(json)).toThrow(
      expect.objectContaining({ code: "editor/invalid-document" }),
    );
  });
});

const typeArb = fc.constantFrom(
  "paragraph",
  "acme.box",
  "acme.list-item",
  "x.y",
);
const value = fc.oneof(
  fc.string({ maxLength: 4 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
const attrsArb = fc.dictionary(
  fc.constantFrom("a", "b", "depth", "src"),
  value,
  { maxKeys: 3 },
);
const markArb = fc.oneof(
  fc.constantFrom<Mark>(
    { type: "bold" },
    { type: "italic" },
    { type: "acme.hl" },
  ),
  fc
    .record({
      href: fc.constantFrom("/a", "#b"),
      title: fc.option(fc.string({ maxLength: 3 })),
    })
    .map((attrs): Mark => ({ type: "link", attrs })),
);
const inlineArb: fc.Arbitrary<InlineNode> = fc.oneof(
  fc
    .record({
      text: fc.string({ maxLength: 4 }),
      marks: fc.uniqueArray(markArb, { maxLength: 2, selector: (m) => m.type }),
    })
    .map(({ text, marks }): InlineNode =>
      marks.length > 0 ? { type: "text", text, marks } : { type: "text", text },
    ),
  fc
    .record({
      type: fc.constantFrom("acme.image", "acme.icon"),
      attrs: attrsArb,
    })
    .map(({ type, attrs }): InlineNode => ({ type, attrs })),
);

interface Tree {
  readonly type: string;
  readonly v: number;
  readonly attrs: Record<string, unknown>;
  readonly content?: readonly Tree[];
  readonly inline?: readonly InlineNode[];
}

const { tree } = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small" },
    fc.record({
      type: typeArb,
      v: fc.integer({ min: 1, max: 3 }),
      attrs: attrsArb,
      inline: fc.array(inlineArb, { maxLength: 3 }),
    }),
    fc.record({
      type: typeArb,
      v: fc.integer({ min: 1, max: 3 }),
      attrs: attrsArb,
      content: fc.array(tie("tree"), { minLength: 1, maxLength: 3 }),
    }),
  ),
}));

function withIds({ content, ...rest }: Tree, next: () => string): BlockNode {
  return {
    ...rest,
    id: next(),
    ...(content && { content: content.map((child) => withIds(child, next)) }),
  };
}

const documentArb = fc.array(tree, { maxLength: 4 }).map((content) => {
  let n = 0;
  return withIds({ type: "doc", v: 1, attrs: {}, content }, () => `b${n++}`);
});

function canonicalInline(inline: InlineNode): InlineNode {
  const attrs = Object.fromEntries(
    Object.entries(inline.attrs ?? {}).filter(([, v]) => v !== null),
  );
  const marks = inline.marks?.map((mark): Mark => {
    const kept = Object.fromEntries(
      Object.entries(mark.attrs ?? {}).filter(([, v]) => v !== null),
    );
    return Object.keys(kept).length > 0
      ? { type: mark.type, attrs: kept }
      : { type: mark.type };
  });
  const { attrs: _a, marks: _m, ...rest } = inline;
  return {
    ...rest,
    ...(Object.keys(attrs).length > 0 && { attrs }),
    ...(marks && marks.length > 0 && { marks }),
  };
}

/** What survives the editor: empty text and children lists dropped, null inline attrs dropped. */
function canonical(block: BlockNode): BlockNode {
  const { content, inline, ...rest } = block;
  const inlineKept = (inline ?? [])
    .filter((child) => !(child.type === "text" && child.text === ""))
    .map(canonicalInline);
  return {
    ...rest,
    ...(content && content.length > 0 && { content: content.map(canonical) }),
    ...(inlineKept.length > 0 && { inline: inlineKept }),
  };
}

describe("editor document round trip", () => {
  it("keeps any document through toEditorDocument and back", () => {
    fc.assert(
      fc.property(documentArb, (source) => {
        const json = JSON.parse(JSON.stringify(toEditorDocument(source)));
        expect(fromEditorDocument(json)).toEqual(canonical(source));
      }),
      { numRuns: 500 },
    );
  });

  it("keeps blocks the schema cannot show exactly", () => {
    const schema = schemaOf(
      { paragraph: [], acme_box: ["a"], acme_image: ["src"] },
      { bold: [] },
    );
    fc.assert(
      fc.property(documentArb, (source) => {
        const json = JSON.parse(
          JSON.stringify(toEditorDocument(source, schema)),
        );
        const restored = fromEditorDocument(json);
        const passthroughIds = new Set(
          (json.content as EditorJsonNode[])
            .filter((child) => child.type === PASSTHROUGH_BLOCK)
            .map((child) => child.attrs?.blockId),
        );
        for (const block of restored.content ?? []) {
          if (passthroughIds.has(block.id)) {
            expect(block).toEqual(
              source.content?.find((original) => original.id === block.id),
            );
          }
        }
        expect(canonical(restored)).toEqual(canonical(source));
      }),
      { numRuns: 500 },
    );
  });
});
