import type {
  BlockNode,
  InlineNode,
  MarkdownCodec,
  MarkdownCodecContext,
  MarkdownDocument,
  SourceMap,
  SourceSlice,
} from "@docleus/sdk";
import type {
  Html,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import {
  directiveFromMarkdown,
  directiveToMarkdown,
} from "mdast-util-directive";
import {
  fromMarkdown,
  type Extension as FromMarkdownExtension,
} from "mdast-util-from-markdown";
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import {
  toMarkdown,
  type Options as ToMarkdownOptions,
} from "mdast-util-to-markdown";
import { directive } from "micromark-extension-directive";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { nanoid } from "nanoid";
import { printFrontmatter, splitFrontmatter } from "./frontmatter.ts";
import { blockToDirective, directiveToBlock } from "./generic.ts";
import { convertGitbookTags } from "./gitbook.ts";
import { hashBlock, hashValue, stableStringify } from "./hash.ts";
import {
  inlineToMdast,
  mdastToInline,
  normalizeInline,
  type InlineHooks,
} from "./inline.ts";

type ToMarkdownExtension = NonNullable<ToMarkdownOptions["extensions"]>[number];
type MicromarkExtension = ReturnType<typeof directive>;

const BLOCK_ID_LENGTH = 10;

export interface ParseOptions {
  /** Convert GitBook `{% tag %}` blocks to the generic tag syntax first. */
  readonly gitbook?: boolean;
}

function collect<T>(
  codecs: readonly MarkdownCodec[],
  pick: (codec: MarkdownCodec) => readonly object[] | undefined,
): T[] {
  return codecs.flatMap((codec) => (pick(codec) ?? []) as T[]);
}

/**
 * Codecs that claim a narrower form of `type` (`code:mermaid` for `code`)
 * come before the rest, so a specific claim wins regardless of load order.
 */
function byClaimPrecedence(
  codecs: readonly MarkdownCodec[],
  type: string,
): readonly MarkdownCodec[] {
  const prefix = `${type}:`;
  const isNarrow = (codec: MarkdownCodec): boolean =>
    codec.claims.some((claim) => claim.startsWith(prefix));
  return [
    ...codecs.filter(isNarrow),
    ...codecs.filter((codec) => !isNarrow(codec)),
  ];
}

function rawBlock(id: string, source: string): BlockNode {
  return { id, type: "raw", v: 1, attrs: { source } };
}

/** Converts between mdast and blocks for one document, with a fixed codec list. */
function converters(
  codecs: readonly MarkdownCodec[],
  source: string,
): MarkdownCodecContext {
  const used = new Set<string>();
  const newId = (): string => {
    let id = nanoid(BLOCK_ID_LENGTH);
    while (used.has(id)) id = nanoid(BLOCK_ID_LENGTH);
    used.add(id);
    return id;
  };
  const sliceOf = (node: RootContent | PhrasingContent): string => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start === undefined || end === undefined
      ? ""
      : source.slice(start, end);
  };

  const hooks: InlineHooks = {
    claim(node) {
      for (const codec of byClaimPrecedence(codecs, node.type)) {
        const inline = codec.toInline?.(node, context);
        if (inline) return inline;
      }
      return undefined;
    },
    print(node) {
      const codec = codecs.find((candidate) =>
        candidate.inlineTypes?.includes(node.type),
      );
      return codec?.fromInline?.(node, context);
    },
    source: sliceOf,
  };

  const toBlock = (node: RootContent): BlockNode => {
    if (node.type === "paragraph") {
      return {
        id: newId(),
        type: "paragraph",
        v: 1,
        attrs: {},
        inline: mdastToInline(node.children, hooks),
      };
    }
    const generic = directiveToBlock(node, newId(), context);
    if (generic) return generic;
    for (const codec of byClaimPrecedence(codecs, node.type)) {
      const block = codec.toBlock?.(node, context);
      if (block) return block;
    }
    return rawBlock(newId(), sliceOf(node));
  };

  const fromBlock = (block: BlockNode): RootContent => {
    if (block.type === "paragraph") {
      const inline = block.inline ?? [];
      const paragraph: Paragraph = {
        type: "paragraph",
        children: inlineToMdast(inline, hooks),
      };
      if (readsBackAsParagraph(codecs, paragraph, inline)) return paragraph;
      // Some text has no Markdown form, such as a paragraph opening with a
      // link whose code-span text holds `]:`, which reads as a definition.
      // The generic tag keeps it exactly.
      return blockToDirective(block, context);
    }
    if (block.type === "raw" && typeof block.attrs.source === "string") {
      const html: Html = { type: "html", value: block.attrs.source };
      return html;
    }
    const codec = codecs.find((candidate) =>
      candidate.blockTypes?.includes(block.type),
    );
    if (codec?.fromBlock) return codec.fromBlock(block, context);
    return blockToDirective(block, context);
  };

  const context: MarkdownCodecContext = {
    toBlocks: (nodes) => nodes.map(toBlock),
    toInline: (nodes) => mdastToInline(nodes, hooks),
    fromBlocks: (blocks) => blocks.map(fromBlock),
    fromInline: (nodes) => inlineToMdast(nodes, hooks),
    newId,
    toGeneric: (block) => blockToDirective(block, context),
  };
  return context;
}

export function parseMarkdown(
  codecs: readonly MarkdownCodec[],
  markdown: string,
  options: ParseOptions = {},
): MarkdownDocument {
  const text = options.gitbook ? convertGitbookTags(markdown) : markdown;
  const { raw, data, body } = splitFrontmatter(text);
  const tree = fromMarkdown(body, {
    extensions: [
      directive(),
      gfmStrikethrough(),
      ...collect<MicromarkExtension>(
        codecs,
        (codec) => codec.syntax?.micromark,
      ),
    ],
    mdastExtensions: [
      directiveFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      ...collect<FromMarkdownExtension>(
        codecs,
        (codec) => codec.syntax?.fromMarkdown,
      ),
    ],
  });
  const context = converters(codecs, body);
  const content: BlockNode[] = [];
  const slices: Record<string, SourceSlice> = {};
  let cursor = 0;
  for (const node of tree.children) {
    const start = node.position?.start.offset ?? cursor;
    const end = node.position?.end.offset ?? start;
    const [block] = context.toBlocks([node]);
    if (!block) continue;
    const previous = content.at(-1)?.id;
    content.push(block);
    slices[block.id] = {
      hash: hashBlock(block),
      text: body.slice(start, end),
      before: body.slice(cursor, start),
      ...(previous !== undefined && { previous }),
    };
    cursor = end;
  }
  const source: SourceMap = {
    blocks: slices,
    end: body.slice(cursor),
    ...(data && { frontmatter: { hash: hashValue(data), text: raw } }),
  };
  return {
    body: { id: context.newId(), type: "doc", v: 1, attrs: {}, content },
    ...(data && { frontmatter: data }),
    source,
  };
}

/** Escapes the printers miss, each found by the round-trip property test. */
const EXTRA_ESCAPES: ToMarkdownExtension = {
  unsafe: [
    // mdast-util-directive escapes `:x` only after another character or at
    // a line start, so one opening a link text or directive label would
    // re-parse as a text directive.
    {
      character: ":",
      after: "[^\\s\\p{P}\\p{S}]",
      inConstruct: ["phrasing"],
      unicode: true,
    },
    // A backslash before a non-punctuation character (one before
    // punctuation already is escaped). Otherwise a literal `\C` before `**`
    // prints as `\&#x43;**`: the character reference mdast-util-to-markdown
    // uses to keep the emphasis valid turns the backslash into an escape.
    { character: "\\", after: "[^!-/:-@[-`{-~]", inConstruct: ["phrasing"] },
    // mdast-util-to-markdown escapes `<` only before a letter, `!`, `/` or
    // `?`, but an email autolink may start with any of these.
    {
      character: "<",
      after: "[\\w.#$%&'*+=^`{|}~-]",
      inConstruct: ["phrasing"],
    },
  ],
};

type Handle = (
  ...args: Parameters<NonNullable<ToMarkdownHandlers["leafDirective"]>>
) => string;
type ToMarkdownHandlers = NonNullable<ToMarkdownExtension["handlers"]>;

/**
 * mdast-util-directive prints leaf and container labels without entering
 * `phrasing`, so characters such as `*` are not escaped in them.
 */
function labelsAsPhrasing(): ToMarkdownExtension {
  const base = directiveToMarkdown();
  const wrap =
    (handle: Handle | undefined): Handle =>
    (node, parent, state, info) => {
      if (!handle)
        throw new Error("mdast-util-directive has no directive handler");
      const exit = state.enter("phrasing");
      try {
        return handle(node, parent, state, info);
      } finally {
        exit();
      }
    };
  const handlers = (base.handlers ?? {}) as ToMarkdownHandlers;
  return {
    handlers: {
      leafDirective: wrap(handlers.leafDirective as Handle | undefined),
      containerDirective: wrap(
        handlers.containerDirective as Handle | undefined,
      ),
    } as ToMarkdownHandlers,
  };
}

/**
 * Whether a printed paragraph parses back to the same inline content.
 * Only text with brackets can be misread (as a link or definition), so
 * other paragraphs skip the check.
 */
function readsBackAsParagraph(
  codecs: readonly MarkdownCodec[],
  paragraph: Paragraph,
  inline: readonly InlineNode[],
): boolean {
  const printed = toMarkdown(
    { type: "root", children: [paragraph] },
    printOptions(codecs),
  );
  if (!/[[\]]/.test(printed)) return true;
  const [block, ...rest] = parseMarkdown(codecs, printed).body.content ?? [];
  return (
    rest.length === 0 &&
    block?.type === "paragraph" &&
    stableStringify(normalizeInline(block.inline ?? [])) ===
      stableStringify(normalizeInline(inline))
  );
}

function printOptions(codecs: readonly MarkdownCodec[]): ToMarkdownOptions {
  return {
    extensions: [
      directiveToMarkdown(),
      labelsAsPhrasing(),
      EXTRA_ESCAPES,
      gfmStrikethroughToMarkdown(),
      ...collect<ToMarkdownExtension>(
        codecs,
        (codec) => codec.syntax?.toMarkdown,
      ),
    ],
  };
}

/**
 * `before` from the import when it still separates blocks, else a blank
 * line. A `before` with a blank line separates any two blocks, so an edited
 * block keeps it too; one without (two HTML blocks, a paragraph then a
 * list) is only safe for an unchanged block after its original predecessor.
 */
function separatorFor(
  slice: SourceSlice | undefined,
  isFirst: boolean,
  followsOriginalPredecessor: boolean,
): string {
  if (isFirst) return slice?.before ?? "";
  if (
    slice &&
    (followsOriginalPredecessor || /\n[ \t]*\n/.test(slice.before))
  ) {
    return slice.before;
  }
  return "\n\n";
}

export function serializeMarkdown(
  codecs: readonly MarkdownCodec[],
  document: MarkdownDocument,
): string {
  const context = converters(codecs, "");
  const options = printOptions(codecs);
  const source = document.source;
  let out = "";

  if (document.frontmatter) {
    const kept = source?.frontmatter;
    out +=
      kept && kept.hash === hashValue(document.frontmatter)
        ? kept.text
        : printFrontmatter(document.frontmatter);
  }

  const blocks = document.body.content ?? [];
  let previousUnchanged: string | undefined;
  blocks.forEach((block, index) => {
    const slice = source?.blocks[block.id];
    const isUnchanged = slice !== undefined && slice.hash === hashBlock(block);
    const followsOriginal =
      previousUnchanged !== undefined && slice?.previous === previousUnchanged;
    out += separatorFor(slice, index === 0, isUnchanged && followsOriginal);
    previousUnchanged = isUnchanged ? block.id : undefined;
    if (isUnchanged) {
      out += slice.text;
      return;
    }
    const root: Root = { type: "root", children: context.fromBlocks([block]) };
    out += toMarkdown(root, options).replace(/\n+$/, "");
  });

  out += source?.end ?? (blocks.length > 0 ? "\n" : "");
  return out;
}
