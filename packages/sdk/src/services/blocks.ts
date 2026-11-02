/** A mark on a run of inline text. `link` carries `attrs.href` and optionally `attrs.title`. */
export interface Mark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/**
 * Inline content of a text-bearing block. Inline nodes have no id; ids
 * belong to blocks only. Core defines `text` (with `text` and `marks`) and
 * `raw` (with `attrs.source`, the verbatim Markdown); other types come from
 * plugins and pass through unchanged when their plugin is missing.
 */
export interface InlineNode {
  readonly type: string;
  readonly text?: string;
  readonly marks?: readonly Mark[];
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly InlineNode[];
}

/**
 * A block. Core defines `doc`, `paragraph` (with `inline`) and `raw` (with
 * `attrs.source`, Markdown kept verbatim because no plugin claims it).
 */
export interface BlockNode {
  /** Unique within its entry. */
  readonly id: string;
  readonly type: string;
  readonly v: number;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly content?: readonly BlockNode[];
  readonly inline?: readonly InlineNode[];
}

/** How a block type is versioned, migrated and indexed for search. */
export interface BlockTypeDefinition {
  /** The current schema version. */
  readonly version: number;
  /** `migrations[n]` turns a version-n node into a version-(n+1) node. */
  readonly migrations?: Readonly<
    Record<number, (node: BlockNode) => BlockNode>
  >;
  /**
   * The searchable plain text of a node of this type, without its
   * children's text (which is collected separately). Defaults to the text
   * of its inline content.
   */
  readonly text?: (node: BlockNode) => string;
}

/**
 * Block type registry with versioned migrations and unknown-block passthrough.
 *
 * @stability experimental
 */
export interface BlocksService {
  /** Throws when `type` is already registered. The returned function unregisters it. */
  register(type: string, definition: BlockTypeDefinition): () => void;
  isKnown(type: string): boolean;
  /**
   * Returns the node migrated step by step to the current version, recursing
   * into `content`. Nodes of unknown types, and nodes at or beyond the
   * current version, are returned unchanged (but their children are still
   * migrated).
   */
  read(node: BlockNode): BlockNode;
  /**
   * The searchable plain text of `node` and its children, one line per
   * text-bearing block: a registered type's `text`, else the text of its
   * inline content (`raw` contributes its source).
   */
  text(node: BlockNode): string;
}
