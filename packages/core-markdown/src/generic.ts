import { DocleusError, type BlockNode, type InlineNode } from "@docleus/sdk";
import type {
  ContainerDirective,
  LeafDirective,
  TextDirective,
} from "mdast-util-directive";
import type { Paragraph, PhrasingContent, RootContent } from "mdast";

/**
 * Directive names of the generic tag syntax: blocks and inline nodes whose
 * plugin is missing export as `:::block{type="acme.callout" ...}` and
 * `:inline[...]{type="acme.mention" ...}`. Types go in an attribute because
 * directive names cannot contain the `.` of a namespaced type.
 */
export const BLOCK_DIRECTIVE = "block";
export const INLINE_DIRECTIVE = "inline";

const RESERVED_ATTRIBUTES = new Set([
  "type",
  "v",
  "attrs",
  "marks",
  "content",
  "inline",
  "text",
]);
const SIMPLE_KEY = /^[A-Za-z][\w-]*$/;
const BRACKET = /[[\]]/;
/** Characters a plain attribute value cannot hold, so the value goes through JSON. */
const UNSAFE_VALUE = /[[\]&|\r\n]/;

interface Converters {
  toBlocks(nodes: readonly RootContent[]): BlockNode[];
  toInline(nodes: readonly PhrasingContent[]): InlineNode[];
  fromBlocks(blocks: readonly BlockNode[]): RootContent[];
  fromInline(nodes: readonly InlineNode[]): PhrasingContent[];
}

const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

/**
 * JSON for an attribute value. Inside strings, brackets and `&` become
 * `\\u` escapes: micromark balances brackets while scanning a directive
 * label, even inside a nested directive's quoted attribute, and
 * mdast-util-directive prints `&` unescaped, so `&amp;` would read back as
 * `&`. GFM splits a table row on `|` before it reads directives, so pipes
 * are escaped too. Structural brackets are always balanced and stay as they
 * are.
 */
function attributeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll(JSON_STRING, (literal) =>
    literal
      .replaceAll("[", "\\u005b")
      .replaceAll("]", "\\u005d")
      .replaceAll("&", "\\u0026")
      .replaceAll("|", "\\u007c"),
  );
}

/** Plain string attrs stay readable as `key="value"`; everything else goes into one JSON attribute. */
export function encodeAttrs(
  attrs: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const simple: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (
      typeof value === "string" &&
      !UNSAFE_VALUE.test(value) &&
      SIMPLE_KEY.test(key) &&
      !RESERVED_ATTRIBUTES.has(key)
    ) {
      simple[key] = value;
    } else {
      rest[key] = value;
    }
  }
  if (Object.keys(rest).length > 0) simple.attrs = attributeJson(rest);
  return simple;
}

export function decodeAttrs(
  attributes: Readonly<Record<string, string | null | undefined>>,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (RESERVED_ATTRIBUTES.has(key) || value === null || value === undefined) {
      continue;
    }
    attrs[key] = value;
  }
  if (attributes.attrs)
    Object.assign(attrs, parseJson(attributes.attrs, "attrs"));
  return attrs;
}

function parseJson(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      `the ${what} attribute is not valid JSON`,
      { cause: error },
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      `the ${what} attribute must be a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function versionOf(
  attributes: Readonly<Record<string, string | null | undefined>>,
): number {
  const v = Number(attributes.v ?? 1);
  if (!Number.isInteger(v) || v < 1) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      `"${attributes.v}" is not a valid version`,
    );
  }
  return v;
}

/**
 * Content a label cannot hold: line breaks, and brackets in code or raw
 * Markdown, which have no escape and which micromark counts while scanning
 * for the label's end.
 */
function needsAttribute(nodes: readonly InlineNode[]): boolean {
  return nodes.some((node) => {
    if (node.text?.includes("\n")) return true;
    const isVerbatim =
      node.type === "raw" ||
      (node.marks ?? []).some((mark) => mark.type === "code");
    const verbatim =
      node.type === "raw"
        ? String(node.attrs?.source ?? "")
        : (node.text ?? "");
    if (isVerbatim && (BRACKET.test(verbatim) || verbatim.includes("\n")))
      return true;
    return node.content !== undefined && needsAttribute(node.content);
  });
}

function header(
  type: string,
  v: number,
  attrs: Readonly<Record<string, unknown>>,
): Record<string, string> {
  return {
    type,
    ...(v !== 1 && { v: String(v) }),
    ...encodeAttrs(attrs),
  };
}

/**
 * Inline content goes in the label. Labels cannot span lines or say "empty
 * but present", so those cases use a JSON `inline` attribute instead.
 */
function label(
  inline: readonly InlineNode[] | undefined,
  converters: Converters,
): { children: PhrasingContent[]; attribute?: string } {
  if (!inline) return { children: [] };
  if (inline.length === 0 || needsAttribute(inline)) {
    return { children: [], attribute: attributeJson(inline) };
  }
  return { children: converters.fromInline(inline) };
}

export function blockToDirective(
  block: BlockNode,
  converters: Converters,
): ContainerDirective | LeafDirective {
  const attributes = header(block.type, block.v, block.attrs);
  const { children, attribute } = label(block.inline, converters);
  if (attribute !== undefined) attributes.inline = attribute;
  if (!block.content) {
    return {
      type: "leafDirective",
      name: BLOCK_DIRECTIVE,
      attributes,
      children,
    };
  }
  if (block.content.length === 0) attributes.content = "";
  const labelParagraph: Paragraph[] =
    children.length > 0
      ? [{ type: "paragraph", data: { directiveLabel: true }, children }]
      : [];
  return {
    type: "containerDirective",
    name: BLOCK_DIRECTIVE,
    attributes,
    children: [
      ...labelParagraph,
      ...converters.fromBlocks(block.content),
    ] as ContainerDirective["children"],
  };
}

function isLabel(node: RootContent): node is Paragraph {
  return (
    node.type === "paragraph" &&
    (node.data as { directiveLabel?: boolean } | undefined)?.directiveLabel ===
      true
  );
}

function inlineFromAttributes(
  attributes: Readonly<Record<string, string | null | undefined>>,
  labelChildren: readonly PhrasingContent[],
  converters: Converters,
): InlineNode[] | undefined {
  const encoded = attributes.inline;
  if (encoded === undefined || encoded === null) {
    return labelChildren.length > 0
      ? converters.toInline(labelChildren)
      : undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      "the inline attribute is not valid JSON",
      { cause: error },
    );
  }
  if (!Array.isArray(value)) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      "the inline attribute must be a JSON array",
    );
  }
  return value as InlineNode[];
}

/** Reads back a generic block tag; returns `undefined` for directives that are not one. */
export function directiveToBlock(
  node: RootContent,
  id: string,
  converters: Converters,
): BlockNode | undefined {
  if (node.type !== "containerDirective" && node.type !== "leafDirective") {
    return undefined;
  }
  if (node.name !== BLOCK_DIRECTIVE) return undefined;
  const attributes = node.attributes ?? {};
  const type = attributes.type;
  if (!type) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      `a "${BLOCK_DIRECTIVE}" tag needs a type attribute`,
    );
  }
  const base = {
    id,
    type,
    v: versionOf(attributes),
    attrs: decodeAttrs(attributes),
  };
  if (node.type === "leafDirective") {
    const inline = inlineFromAttributes(attributes, node.children, converters);
    return inline ? { ...base, inline } : base;
  }
  const [first, ...others] = node.children;
  const labelNode = first && isLabel(first) ? first : undefined;
  const body = labelNode ? others : node.children;
  const inline = inlineFromAttributes(
    attributes,
    labelNode?.children ?? [],
    converters,
  );
  const content = converters.toBlocks(body);
  return {
    ...base,
    ...(inline && { inline }),
    content,
  };
}

function parseText(encoded: string): string {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      "the text attribute is not a JSON string",
      { cause: error },
    );
  }
  if (typeof value !== "string") {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      "the text attribute is not a JSON string",
    );
  }
  return value;
}

/**
 * Inline nodes of unknown types, and text carrying unknown marks
 * (`type="text"` with a `marks` attribute), as `:inline[label]{...}`.
 */
export function inlineToDirective(
  node: InlineNode,
  converters: Converters,
): TextDirective {
  const attributes = header(node.type, 1, node.attrs ?? {});
  if (node.text !== undefined) attributes.text = attributeJson(node.text);
  if (node.marks && node.marks.length > 0) {
    attributes.marks = attributeJson(node.marks);
  }
  const { children, attribute } = label(node.content, converters);
  if (attribute !== undefined) attributes.inline = attribute;
  return {
    type: "textDirective",
    name: INLINE_DIRECTIVE,
    attributes,
    children,
  };
}

export function directiveToInline(
  node: TextDirective,
  converters: Converters,
): InlineNode {
  const attributes = node.attributes ?? {};
  const type = attributes.type;
  if (!type) {
    throw new DocleusError(
      "markdown/invalid-generic-tag",
      `an "${INLINE_DIRECTIVE}" tag needs a type attribute`,
    );
  }
  const { text: encodedText, ...others } = attributes;
  const text =
    typeof encodedText === "string" ? parseText(encodedText) : undefined;
  const attrs = decodeAttrs(others);
  const marks = attributes.marks
    ? (JSON.parse(attributes.marks) as InlineNode["marks"])
    : undefined;
  const content = inlineFromAttributes(attributes, node.children, converters);
  return {
    type,
    ...(text !== undefined && { text }),
    ...(marks && { marks }),
    ...(Object.keys(attrs).length > 0 && { attrs }),
    ...(content && { content }),
  };
}
