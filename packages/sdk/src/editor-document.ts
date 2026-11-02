import { DocleusError } from "@docleus/kernel";
import { z } from "zod";
import type { BlockNode, InlineNode, Mark } from "./services/blocks.ts";

/** A mark in ProseMirror JSON. */
export interface EditorJsonMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** A node in ProseMirror JSON, as `Node.toJSON()` and Tiptap's `getJSON()` produce it. */
export interface EditorJsonNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly EditorJsonNode[];
  readonly marks?: readonly EditorJsonMark[];
  readonly text?: string;
}

/** The editor node attribute that holds a block's id. Every block node has it. */
export const BLOCK_ID_ATTR = "blockId";
/** The editor node attribute that holds a block's schema version. */
export const BLOCK_VERSION_ATTR = "blockVersion";
/** The editor node for a block the editor cannot show: its whole block sits in `attrs.block`. */
export const PASSTHROUGH_BLOCK = "passthroughBlock";
/** The editor node for inline content the editor cannot show: the inline node sits in `attrs.inline`. */
export const PASSTHROUGH_INLINE = "passthroughInline";

const RESERVED_ATTRS = new Set([BLOCK_ID_ATTR, BLOCK_VERSION_ATTR]);
const SEGMENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
const TYPE_PATTERN = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`);
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function encode(type: string): string | undefined {
  return TYPE_PATTERN.test(type)
    ? type.replaceAll("-", "__").replaceAll(".", "_")
    : undefined;
}

/**
 * The editor node or mark name of a block, inline or mark type:
 * `commonmark.list-item` becomes `commonmark_list__item`. ProseMirror content
 * expressions only accept word characters, hence the encoding. Throws for a
 * type outside `segment(.segment)*` with lowercase, digit and `-` segments.
 *
 * @stability experimental
 */
export function editorNodeName(type: string): string {
  const name = encode(type);
  if (name === undefined) {
    throw new DocleusError(
      "editor/invalid-type",
      `"${type}" has no editor node name`,
    );
  }
  return name;
}

/**
 * The block, inline or mark type of an editor name; the inverse of
 * {@link editorNodeName}.
 *
 * @stability experimental
 */
export function blockTypeOf(name: string): string {
  const type = NAME_PATTERN.test(name)
    ? name.replaceAll("__", "-").replaceAll("_", ".")
    : undefined;
  if (type === undefined || encode(type) !== name) {
    throw new DocleusError(
      "editor/invalid-name",
      `"${name}" is not an editor name of a type`,
    );
  }
  return type;
}

/** What the editor schema can show, so the rest is kept as passthrough nodes. */
export interface EditorSchemaInfo {
  /** The attribute names of node `name`, or `undefined` when the schema has no such node. */
  nodeAttrs(name: string): ReadonlySet<string> | undefined;
  /** The attribute names of mark `name`, or `undefined` when the schema has no such mark. */
  markAttrs(name: string): ReadonlySet<string> | undefined;
}

const fits = (
  attrs: Readonly<Record<string, unknown>> | undefined,
  allowed: ReadonlySet<string> | undefined,
): boolean =>
  allowed !== undefined &&
  Object.keys(attrs ?? {}).every(
    (key) => allowed.has(key) && !RESERVED_ATTRS.has(key),
  );

/**
 * The passthrough node of `block`, which keeps it verbatim (children included)
 * whatever the editor schema is.
 *
 * @stability experimental
 */
export function toPassthroughBlock(block: BlockNode): EditorJsonNode {
  return {
    type: PASSTHROUGH_BLOCK,
    attrs: {
      [BLOCK_ID_ATTR]: block.id,
      [BLOCK_VERSION_ATTR]: block.v,
      block,
    },
  };
}

function inlineToEditor(
  node: InlineNode,
  schema: EditorSchemaInfo | undefined,
): EditorJsonNode | undefined {
  const passthrough: EditorJsonNode = {
    type: PASSTHROUGH_INLINE,
    attrs: { inline: node },
  };
  const marks: EditorJsonMark[] = [];
  for (const mark of node.marks ?? []) {
    const name = encode(mark.type);
    if (name === undefined) return passthrough;
    if (schema && !fits(mark.attrs, schema.markAttrs(name))) return passthrough;
    marks.push(mark.attrs ? { type: name, attrs: mark.attrs } : { type: name });
  }
  const withMarks = marks.length > 0 ? { marks } : {};
  if (node.type === "text") {
    // ProseMirror has no empty text nodes; empty text carries no content.
    if (node.text === "") return undefined;
    if (
      node.text === undefined ||
      node.attrs !== undefined ||
      node.content !== undefined
    ) {
      return passthrough;
    }
    return { type: "text", text: node.text, ...withMarks };
  }
  const name = encode(node.type);
  if (
    name === undefined ||
    node.text !== undefined ||
    (schema && !fits(node.attrs, schema.nodeAttrs(name)))
  ) {
    return passthrough;
  }
  const content = inlineListToEditor(node.content, schema);
  return {
    type: name,
    ...(node.attrs && { attrs: node.attrs }),
    ...(content.length > 0 && { content }),
    ...withMarks,
  };
}

function inlineListToEditor(
  nodes: readonly InlineNode[] | undefined,
  schema: EditorSchemaInfo | undefined,
): EditorJsonNode[] {
  return (nodes ?? []).flatMap((node) => inlineToEditor(node, schema) ?? []);
}

function blockToEditor(
  block: BlockNode,
  schema: EditorSchemaInfo | undefined,
): EditorJsonNode {
  const name = encode(block.type);
  const hasBoth =
    (block.content?.length ?? 0) > 0 && (block.inline?.length ?? 0) > 0;
  if (
    name === undefined ||
    hasBoth ||
    Object.keys(block.attrs).some((key) => RESERVED_ATTRS.has(key)) ||
    (schema && !fits(block.attrs, schema.nodeAttrs(name)))
  ) {
    return toPassthroughBlock(block);
  }
  const content =
    (block.content?.length ?? 0) > 0
      ? (block.content ?? []).map((child) => blockToEditor(child, schema))
      : inlineListToEditor(block.inline, schema);
  return {
    type: name,
    attrs: {
      ...block.attrs,
      [BLOCK_ID_ATTR]: block.id,
      [BLOCK_VERSION_ATTR]: block.v,
    },
    ...(content.length > 0 && { content }),
  };
}

/**
 * Converts a `doc` block to ProseMirror JSON. Every block becomes a node
 * named by {@link editorNodeName}, with its attrs plus {@link BLOCK_ID_ATTR}
 * and {@link BLOCK_VERSION_ATTR}. With `schema`, blocks, inline nodes and
 * marks the schema cannot show become {@link PASSTHROUGH_BLOCK} and
 * {@link PASSTHROUGH_INLINE} nodes, so {@link fromEditorDocument} restores
 * them unchanged. Empty text is dropped.
 *
 * @stability experimental
 */
export function toEditorDocument(
  doc: BlockNode,
  schema?: EditorSchemaInfo,
): EditorJsonNode {
  if (doc.type !== "doc") {
    throw new DocleusError(
      "editor/invalid-document",
      `expected a doc block, got "${doc.type}"`,
    );
  }
  return {
    type: "doc",
    attrs: {
      ...doc.attrs,
      [BLOCK_ID_ATTR]: doc.id,
      [BLOCK_VERSION_ATTR]: doc.v,
    },
    content: (doc.content ?? []).map((block) => blockToEditor(block, schema)),
  };
}

const attrsSchema = z.record(z.string(), z.unknown());

const jsonNodeSchema: z.ZodType<EditorJsonNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: attrsSchema.optional(),
    content: z.array(jsonNodeSchema).optional(),
    marks: z
      .array(
        z.object({ type: z.string().min(1), attrs: attrsSchema.optional() }),
      )
      .optional(),
    text: z.string().optional(),
  }),
);

const markSchema = z.object({
  type: z.string().min(1),
  attrs: attrsSchema.optional(),
});

const inlineSchema: z.ZodType<InlineNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    text: z.string().optional(),
    marks: z.array(markSchema).optional(),
    attrs: attrsSchema.optional(),
    content: z.array(inlineSchema).optional(),
  }),
);

const blockSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    v: z.number().int().min(1),
    attrs: attrsSchema,
    content: z.array(blockSchema).optional(),
    inline: z.array(inlineSchema).optional(),
  }),
);

function invalid(message: string, cause?: unknown): DocleusError {
  return new DocleusError(
    "editor/invalid-document",
    `invalid editor document: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function withoutNulls(
  attrs: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const kept = Object.entries(attrs ?? {}).filter(
    ([, value]) => value !== null,
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

const isBlockNode = (node: EditorJsonNode): boolean =>
  node.attrs !== undefined && BLOCK_ID_ATTR in node.attrs;

function markFromEditor(mark: EditorJsonMark): Mark {
  const attrs = withoutNulls(mark.attrs);
  return { type: blockTypeOf(mark.type), ...(attrs && { attrs }) };
}

function inlineFromEditor(node: EditorJsonNode): InlineNode {
  if (node.type === PASSTHROUGH_INLINE) {
    const parsed = inlineSchema.safeParse(node.attrs?.inline);
    if (!parsed.success) throw invalid("bad passthrough inline", parsed.error);
    return parsed.data;
  }
  const marks = (node.marks ?? []).map(markFromEditor);
  const withMarks = marks.length > 0 ? { marks } : {};
  if (node.type === "text") {
    if (node.text === undefined) throw invalid("text node without text");
    return { type: "text", text: node.text, ...withMarks };
  }
  const attrs = withoutNulls(node.attrs);
  const content = (node.content ?? []).map(inlineFromEditor);
  return {
    type: blockTypeOf(node.type),
    ...(attrs && { attrs }),
    ...(content.length > 0 && { content }),
    ...withMarks,
  };
}

function blockFromEditor(node: EditorJsonNode): BlockNode {
  const attrs = node.attrs ?? {};
  const id = attrs[BLOCK_ID_ATTR];
  if (typeof id !== "string" || id === "") {
    throw invalid(`a "${node.type}" node has no block id`);
  }
  if (node.type === PASSTHROUGH_BLOCK) {
    const parsed = blockSchema.safeParse(attrs.block);
    if (!parsed.success) throw invalid("bad passthrough block", parsed.error);
    return { ...parsed.data, id };
  }
  const v = attrs[BLOCK_VERSION_ATTR];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw invalid(`block "${id}" has no schema version`);
  }
  const children = node.content ?? [];
  const blocks = children.filter(isBlockNode);
  if (blocks.length > 0 && blocks.length < children.length) {
    throw invalid(`block "${id}" mixes blocks and inline content`);
  }
  const content = blocks.map(blockFromEditor);
  const inline = blocks.length > 0 ? [] : children.map(inlineFromEditor);
  return {
    id,
    type: node.type === "doc" ? "doc" : blockTypeOf(node.type),
    v,
    attrs: Object.fromEntries(
      Object.entries(attrs).filter(([key]) => !RESERVED_ATTRS.has(key)),
    ),
    ...(content.length > 0 && { content }),
    ...(inline.length > 0 && { inline }),
  };
}

function collectIds(block: BlockNode, seen: Set<string>): void {
  if (seen.has(block.id)) throw invalid(`block id "${block.id}" is not unique`);
  seen.add(block.id);
  for (const child of block.content ?? []) collectIds(child, seen);
}

/**
 * Converts ProseMirror JSON back to a `doc` block; the inverse of
 * {@link toEditorDocument}. Every block node must carry a non-empty
 * {@link BLOCK_ID_ATTR}, unique in the document (passthrough contents
 * included), and a {@link BLOCK_VERSION_ATTR}. Passthrough nodes yield the
 * block or inline node they hold. Block attrs are kept as they are; `null`
 * attrs of marks and inline nodes are dropped, since the editor fills unset
 * attributes with `null`. A block without children has neither `content`
 * nor `inline`. Throws `editor/invalid-document` for anything else.
 *
 * @stability experimental
 */
export function fromEditorDocument(json: unknown): BlockNode {
  const parsed = jsonNodeSchema.safeParse(json);
  if (!parsed.success) throw invalid("malformed JSON", parsed.error);
  if (parsed.data.type !== "doc") throw invalid("the root is not a doc node");
  let doc: BlockNode;
  try {
    doc = blockFromEditor(parsed.data);
  } catch (error) {
    if (error instanceof DocleusError) {
      if (error.code === "editor/invalid-document") throw error;
      throw invalid(error.message, error);
    }
    throw error;
  }
  collectIds(doc, new Set());
  return doc;
}
