import type { InlineNode, Mark } from "@docleus/sdk";
import type { TextDirective } from "mdast-util-directive";
import type { Html, PhrasingContent } from "mdast";
import {
  directiveToInline,
  INLINE_DIRECTIVE,
  inlineToDirective,
} from "./generic.ts";
import { stableStringify } from "./hash.ts";

/** Core marks, outermost first: the nesting order used when printing. */
export const CORE_MARKS = ["link", "strike", "bold", "italic", "code"] as const;
const CORE_MARK_SET = new Set<string>(CORE_MARKS);

const WRAPPERS = {
  strong: "bold",
  emphasis: "italic",
  delete: "strike",
} as const;

export interface InlineHooks {
  /** A plugin codec's reading of `node`, if any codec claims it. */
  claim(node: PhrasingContent): InlineNode | undefined;
  /** A plugin codec's printing of `node`, if its type is claimed. */
  print(node: InlineNode): PhrasingContent | undefined;
  /** The original Markdown of a node, for constructs nobody claims. */
  source(node: PhrasingContent): string;
}

export function rawInline(source: string): InlineNode {
  return { type: "raw", attrs: { source } };
}

export function mdastToInline(
  nodes: readonly PhrasingContent[],
  hooks: InlineHooks,
): InlineNode[] {
  const out: InlineNode[] = [];
  const visit = (node: PhrasingContent, marks: readonly Mark[]): void => {
    switch (node.type) {
      case "text":
        out.push(textNode(node.value, marks));
        return;
      case "inlineCode":
        out.push(textNode(node.value, [...marks, { type: "code" }]));
        return;
      case "strong":
      case "emphasis":
      case "delete":
        for (const child of node.children) {
          visit(child, [...marks, { type: WRAPPERS[node.type] }]);
        }
        return;
      case "link": {
        const link: Mark = {
          type: "link",
          attrs: {
            href: node.url,
            ...(node.title !== null &&
              node.title !== undefined && { title: node.title }),
          },
        };
        for (const child of node.children) visit(child, [...marks, link]);
        return;
      }
      default:
        break;
    }
    const directive = node as unknown as TextDirective;
    if (
      directive.type === "textDirective" &&
      directive.name === INLINE_DIRECTIVE
    ) {
      const inline = directiveToInline(directive, {
        toInline: (children) => mdastToInline(children, hooks),
        fromInline: (children) => inlineToMdast(children, hooks),
        toBlocks: () => [],
        fromBlocks: () => [],
      });
      out.push(withMarks(inline, marks));
      return;
    }
    const claimed = hooks.claim(node);
    out.push(withMarks(claimed ?? rawInline(hooks.source(node)), marks));
  };
  for (const node of nodes) visit(node, []);
  return normalizeInline(out);
}

function withMarks(node: InlineNode, marks: readonly Mark[]): InlineNode {
  return marks.length > 0
    ? { ...node, marks: [...marks, ...(node.marks ?? [])] }
    : node;
}

function textNode(text: string, marks: readonly Mark[]): InlineNode {
  return marks.length > 0
    ? { type: "text", text, marks }
    : { type: "text", text };
}

function compareMarks(a: Mark, b: Mark): number {
  const ia = CORE_MARKS.indexOf(a.type as (typeof CORE_MARKS)[number]);
  const ib = CORE_MARKS.indexOf(b.type as (typeof CORE_MARKS)[number]);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  const sa = stableStringify(a);
  const sb = stableStringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sameMarks(a: readonly Mark[] = [], b: readonly Mark[] = []): boolean {
  return (
    a.length === b.length &&
    a.every((mark, i) => stableStringify(mark) === stableStringify(b[i]))
  );
}

/**
 * The canonical form of inline content: marks sorted and deduplicated,
 * adjacent text with equal marks merged, empty text dropped.
 */
export function normalizeInline(nodes: readonly InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    let current = node;
    if (current.marks) {
      const unique = new Map(
        current.marks.map((mark) => [stableStringify(mark), mark]),
      );
      const marks = [...unique.values()].toSorted(compareMarks);
      const { marks: _marks, ...rest } = current;
      current = marks.length > 0 ? { ...rest, marks } : rest;
    }
    if (current.content) {
      current = { ...current, content: normalizeInline(current.content) };
    }
    if (current.type === "text") {
      if (!current.text) continue;
      const previous = out.at(-1);
      if (
        previous?.type === "text" &&
        previous.attrs === undefined &&
        current.attrs === undefined &&
        sameMarks(previous.marks, current.marks)
      ) {
        out[out.length - 1] = {
          ...previous,
          text: `${previous.text ?? ""}${current.text}`,
        };
        continue;
      }
    }
    out.push(current);
  }
  return out;
}

function hasOnlyCoreMarks(node: InlineNode): boolean {
  return (node.marks ?? []).every((mark) => CORE_MARK_SET.has(mark.type));
}

function linkKey(mark: Mark): string {
  return stableStringify(mark.attrs ?? {});
}

/**
 * The mark to print around `node` and its neighbours. Only text can sit in a
 * code span, so other nodes with a code mark get none and keep every mark in
 * the generic tag.
 */
function outerMark(node: InlineNode): Mark | undefined {
  if (!hasOnlyCoreMarks(node)) return undefined;
  const marks = node.marks ?? [];
  if (node.type !== "text" && marks.some((mark) => mark.type === "code")) {
    return undefined;
  }
  return marks.toSorted(compareMarks)[0];
}

function sameOuter(a: Mark, b: Mark): boolean {
  return a.type === b.type && (a.type !== "link" || linkKey(a) === linkKey(b));
}

function withoutMark(node: InlineNode, mark: Mark): InlineNode {
  const marks = (node.marks ?? []).filter(
    (candidate) => !sameOuter(candidate, mark),
  );
  if (node.type === "text") return textNode(node.text ?? "", marks);
  const { marks: _marks, ...rest } = node;
  return marks.length > 0 ? { ...rest, marks } : rest;
}

function wrap(mark: Mark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type) {
    case "link": {
      const attrs = mark.attrs ?? {};
      return {
        type: "link",
        url: String(attrs.href ?? ""),
        title: typeof attrs.title === "string" ? attrs.title : null,
        children,
      };
    }
    case "strike":
      return { type: "delete", children };
    case "bold":
      return { type: "strong", children };
    default:
      return { type: "emphasis", children };
  }
}

export function inlineToMdast(
  input: readonly InlineNode[],
  hooks: InlineHooks,
): PhrasingContent[] {
  // Adjacent runs with equal marks must print as one span: two code spans
  // side by side would read back as different text.
  const nodes = normalizeInline(input);
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (!node) break;
    const mark = outerMark(node);
    if (!mark) {
      out.push(printSingle(node, hooks));
      i += 1;
      continue;
    }
    if (mark.type === "code") {
      out.push({ type: "inlineCode", value: node.text ?? "" });
      i += 1;
      continue;
    }
    const group: InlineNode[] = [];
    while (i < nodes.length) {
      const candidate = nodes[i];
      const candidateMark = candidate && outerMark(candidate);
      if (!candidate || !candidateMark || !sameOuter(candidateMark, mark))
        break;
      group.push(withoutMark(candidate, mark));
      i += 1;
    }
    out.push(wrap(mark, inlineToMdast(group, hooks)));
  }
  return out;
}

function printSingle(node: InlineNode, hooks: InlineHooks): PhrasingContent {
  if (node.type === "text" && hasOnlyCoreMarks(node)) {
    return { type: "text", value: node.text ?? "" };
  }
  const isUnmarked = (node.marks ?? []).length === 0;
  if (
    isUnmarked &&
    node.type === "raw" &&
    typeof node.attrs?.source === "string"
  ) {
    const html: Html = { type: "html", value: node.attrs.source };
    return html;
  }
  const printed =
    isUnmarked && node.type !== "text" ? hooks.print(node) : undefined;
  if (printed) return printed;
  return inlineToDirective(node, {
    toInline: (children) => mdastToInline(children, hooks),
    fromInline: (children) => inlineToMdast(children, hooks),
    toBlocks: () => [],
    fromBlocks: () => [],
  }) as unknown as PhrasingContent;
}
