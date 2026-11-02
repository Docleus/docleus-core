import type { PhrasingContent, RootContent } from "mdast";
import type { BlockNode, InlineNode } from "./blocks.ts";

/**
 * Parser and printer extensions, passed through unchanged: micromark syntax
 * extensions, `mdast-util-from-markdown` extensions and
 * `mdast-util-to-markdown` extensions.
 */
export interface MarkdownSyntax {
  readonly micromark?: readonly object[];
  readonly fromMarkdown?: readonly object[];
  readonly toMarkdown?: readonly object[];
}

/** Helpers a codec uses to convert the children of the node it handles. */
export interface MarkdownCodecContext {
  /** Converts mdast block children (for example a list item's) into blocks. */
  toBlocks(nodes: readonly RootContent[]): BlockNode[];
  toInline(nodes: readonly PhrasingContent[]): InlineNode[];
  fromBlocks(blocks: readonly BlockNode[]): RootContent[];
  fromInline(nodes: readonly InlineNode[]): PhrasingContent[];
  /** A fresh block id, unique within the document being parsed. */
  newId(): string;
  /**
   * Prints `block` in the generic tag syntax, its children through their own
   * codecs, so it reads back unchanged. For a block that has no Markdown
   * form, such as a task item whose first paragraph prints as a tag.
   *
   * @stability experimental
   */
  toGeneric(block: BlockNode): RootContent;
}

/**
 * How a plugin's blocks and inline nodes read from and write to Markdown.
 * On import, codecs are asked in registration order and the first that
 * returns a node wins, except that codecs claiming a narrower form of the
 * node's type (`code:mermaid` for a `code` node) are asked first; nodes
 * nobody claims become core `raw` blocks or inline nodes that keep their
 * source verbatim.
 */
export interface MarkdownCodec {
  /** Unique name, usually the plugin's. */
  readonly name: string;
  /**
   * Syntax this codec owns, such as `heading` or `directive:acme.callout`.
   * Registering a claim another codec holds throws.
   */
  readonly claims: readonly string[];
  readonly syntax?: MarkdownSyntax;
  /** Block types `fromBlock` writes. */
  readonly blockTypes?: readonly string[];
  /** Inline types `fromInline` writes. */
  readonly inlineTypes?: readonly string[];
  toBlock?(
    node: RootContent,
    context: MarkdownCodecContext,
  ): BlockNode | undefined;
  fromBlock?(block: BlockNode, context: MarkdownCodecContext): RootContent;
  toInline?(
    node: PhrasingContent,
    context: MarkdownCodecContext,
  ): InlineNode | undefined;
  fromInline?(node: InlineNode, context: MarkdownCodecContext): PhrasingContent;
}

/** The original text of one top-level block, used to export it unchanged. */
export interface SourceSlice {
  /** Hash of the block as imported; a different hash means it was edited. */
  readonly hash: string;
  readonly text: string;
  /** Whitespace between the previous block (or the frontmatter) and this one. */
  readonly before: string;
  /**
   * Id of the block that preceded this one at import, if any. `before` is
   * kept even without a blank line only while that block still precedes it.
   */
  readonly previous?: string;
}

/** Formatting kept from an import so that unchanged parts export byte for byte. */
export interface SourceMap {
  readonly blocks: Readonly<Record<string, SourceSlice>>;
  /** Text after the last block. */
  readonly end: string;
  readonly frontmatter?: { readonly hash: string; readonly text: string };
}

/** A parsed Markdown file: its block tree, frontmatter and source map. */
export interface MarkdownDocument {
  /** A `doc` block whose content is the top-level blocks. */
  readonly body: BlockNode;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
  readonly source?: SourceMap;
}

/** A space as a directory: relative path to file contents. */
export type SpaceFiles = Readonly<Record<string, string>>;

/** One Markdown file of a space directory, as an entry of the tree. */
export interface DirectoryEntry {
  /** Relative path of the Markdown file, which also identifies the entry. */
  readonly path: string;
  readonly title: string;
  /** Path of the parent entry, or `undefined` at the top level. */
  readonly parent: string | undefined;
  readonly order: number;
  readonly document: MarkdownDocument;
}

/** A space directory read by `markdown.readDirectory`. */
export interface DirectoryImport {
  readonly entries: readonly DirectoryEntry[];
  /** Parsed `.docleus.yaml`, empty when absent. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Original `.docleus.yaml`, kept so an unchanged config exports verbatim. */
  readonly configText: string | undefined;
  /** Original `SUMMARY.md`, kept so an unchanged tree exports it verbatim. */
  readonly summary: string | undefined;
  readonly warnings: readonly string[];
}

/**
 * The Markdown codec: parsing, round-trip serialization, and codecs plugins register for their syntax.
 *
 * @stability experimental
 */
export interface MarkdownService {
  /** Throws on a claim another codec already holds. The returned function unregisters it. */
  register(codec: MarkdownCodec): () => void;
  /** `gitbook: true` first converts GitBook `{% tag %}` blocks to the generic tag syntax. */
  parse(markdown: string, options?: { gitbook?: boolean }): MarkdownDocument;
  /** Unchanged blocks and frontmatter use their source slices; the rest is printed canonically. */
  serialize(document: MarkdownDocument): string;
  /**
   * Reads a space directory. `SUMMARY.md` defines the tree when present;
   * otherwise directories nest entries and frontmatter `order`, then the
   * file name, orders siblings.
   */
  importDirectory(files: SpaceFiles): DirectoryImport;
  /** Writes entries back to files, always including a `SUMMARY.md`. */
  exportDirectory(
    input: Pick<
      DirectoryImport,
      "entries" | "config" | "configText" | "summary"
    >,
  ): Record<string, string>;
}
