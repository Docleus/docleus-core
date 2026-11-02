import type { BlockNode } from "./blocks.ts";
import type { UiComponent } from "./ui.ts";

/**
 * A handle on the running editor, passed to toolbar items, slash items and
 * block views. Names are block, inline or mark types (`commonmark.heading`),
 * not editor node names.
 */
export interface EditorHandle {
  /** Whether the selection is in a block or has a mark of `type`, with `attrs` when given. */
  isActive(type: string, attrs?: Readonly<Record<string, unknown>>): boolean;
  /** Toggles a mark on the selection. */
  toggleMark(type: string, attrs?: Readonly<Record<string, unknown>>): boolean;
  /** Turns the textblocks in the selection into blocks of `type`. */
  setBlock(type: string, attrs?: Readonly<Record<string, unknown>>): boolean;
  /** Wraps the selected blocks in a container block of `type`. */
  wrapIn(type: string, attrs?: Readonly<Record<string, unknown>>): boolean;
  /**
   * Inserts a block of `type` after the selection, with optional inline
   * text. Required children are filled in with their defaults.
   */
  insertBlock(
    type: string,
    attrs?: Readonly<Record<string, unknown>>,
    text?: string,
  ): boolean;
  /**
   * Inserts a block tree after the selection. Empty ids are allowed; the
   * editor gives every block without one a fresh id.
   */
  insertTree(block: BlockNode): boolean;
  /** Merges `patch` into the attrs of the innermost selected block of `type`. */
  updateBlock(type: string, patch: Readonly<Record<string, unknown>>): boolean;
  /** Inserts an inline node of `type` at the selection. */
  insertInline(
    type: string,
    attrs?: Readonly<Record<string, unknown>>,
  ): boolean;
  focus(): void;
  /** The Tiptap `Editor`. Its API may change with Tiptap versions. */
  readonly unstable_tiptap: unknown;
}

/** Props of a block's React view. */
export interface BlockViewProps {
  readonly attrs: Readonly<Record<string, unknown>>;
  /** Merges `patch` into the block's attrs. */
  updateAttrs(patch: Readonly<Record<string, unknown>>): void;
  readonly isSelected: boolean;
  readonly isEditable: boolean;
  /** Renders the block's editable children; only for blocks with content. */
  readonly Content: UiComponent<{ readonly as?: string }>;
}

/** Props of a block's settings panel. */
export interface BlockSettingsProps {
  readonly type: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  updateAttrs(patch: Readonly<Record<string, unknown>>): void;
  /** The selected block with its children; for inline nodes, `undefined`. */
  readonly block: BlockNode | undefined;
  /**
   * Child indexes from `block` to the block that holds the cursor, or to the
   * selected child block; empty when `block` itself is selected. For a table,
   * `[row, column]`.
   */
  readonly path: readonly number[];
  /**
   * Replaces the selected block and its children; empty ids get fresh ones.
   * The cursor moves to `path` in the new block (default: the current path),
   * clamped to the children that exist.
   */
  replaceBlock(block: BlockNode, path?: readonly number[]): void;
  readonly editor: EditorHandle;
}

/**
 * A Markdown-style shortcut: typing text that matches `pattern` at the start
 * of a textblock turns it into (or, for container blocks, wraps it in) the
 * block. When the textblock is already the first child of a container block
 * of that type, the shortcut merges its attrs into that block instead of
 * nesting another. `pattern` must end with `$`.
 *
 * When the shortcuts of several blocks match the same text, the most specific
 * one applies, whatever order the plugins registered in: the one whose match
 * has the most characters outside capture groups (so `` ^```mermaid\s$ ``
 * beats `` ^```([\w-]+)?\s$ ``), ties going to the block type that sorts
 * first. Put the variable parts of a pattern in capture groups.
 */
export interface EditorShortcut {
  readonly pattern: RegExp;
  attrs?(match: readonly string[]): Readonly<Record<string, unknown>>;
}

/**
 * Key handlers by key, in ProseMirror notation (`Enter`, `Shift-Enter`,
 * `Mod-b`). A handler returns `true` when it handled the key.
 */
export type EditorKeys = Readonly<
  Record<string, (editor: EditorHandle) => boolean>
>;

/**
 * The HTML tag of an editor node: a fixed tag, or one computed from the
 * node's attrs. When an attr change changes the tag, the editor recreates the
 * node's element (and its view).
 */
export type EditorTag =
  string | ((attrs: Readonly<Record<string, unknown>>) => string);

/**
 * A block type in the editor, as the high-level API describes it. The editor
 * builds the editor node from it; `node` replaces that with a raw Tiptap
 * `Node` named {@link editorNodeName}`(type)` for advanced cases.
 */
export interface EditorBlockDefinition {
  readonly type: string;
  /** The schema version new blocks get. */
  readonly version: number;
  /**
   * `inline`: a textblock. `blocks`: a container of child blocks. `atom`:
   * no editable children; all data is in attrs.
   */
  readonly content: "inline" | "blocks" | "atom";
  /** A ProseMirror content expression over editor node names, for `blocks`. Defaults to `block+`. */
  readonly children?: string;
  /** Node groups. Defaults to `block`; child-only types such as list items use their own. */
  readonly group?: string;
  /** Attrs with their defaults for new blocks. */
  readonly attrs?: Readonly<Record<string, unknown>>;
  /**
   * The HTML tag in the editor, or a function of the block's attrs, such as
   * `` (attrs) => `h${attrs.depth}` `` for a heading. Defaults to `div`.
   */
  readonly tag?: EditorTag;
  /** Whether the content is code: no marks, and whitespace is kept. */
  readonly isCode?: boolean;
  /** Whether Enter at the end of the block leaves it for a paragraph. Applies to `inline`. */
  readonly isDefining?: boolean;
  /**
   * Whether the block is a list item, for `blocks`: Enter splits the item,
   * Tab nests it in the previous item, Shift-Tab lifts it out.
   */
  readonly isListItem?: boolean;
  /**
   * Whether editing commands such as joining and lifting stop at the block's
   * boundary, as they should for table cells.
   */
  readonly isIsolating?: boolean;
  /** A React view, rendered inside an element of `tag`; a new tag recreates the view. */
  readonly view?: UiComponent<BlockViewProps>;
  /** A React panel shown in the block settings slot while the block is selected. */
  readonly settings?: UiComponent<BlockSettingsProps>;
  readonly shortcuts?: readonly EditorShortcut[];
  /** Keyboard shortcuts while the selection is in a block of this type. */
  readonly keys?: EditorKeys;
  /** A raw Tiptap `Node`, replacing the one built from this definition. */
  readonly node?: unknown;
}

/** An inline node type in the editor. Inline nodes are atoms. */
export interface EditorInlineDefinition {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  /** The HTML tag in the editor, or a function of the node's attrs. Defaults to `span`. */
  readonly tag?: EditorTag;
  /** Keyboard shortcuts anywhere in the editor; see {@link EditorKeys}. */
  readonly keys?: EditorKeys;
  readonly view?: UiComponent<Omit<BlockViewProps, "Content">>;
  readonly settings?: UiComponent<BlockSettingsProps>;
  /** A raw Tiptap `Node` named {@link editorNodeName}`(type)`. */
  readonly node?: unknown;
}

/** A mark type in the editor. */
export interface EditorMarkDefinition {
  readonly type: string;
  /** A raw Tiptap `Mark` named {@link editorNodeName}`(type)`. */
  readonly mark: unknown;
}

/**
 * A button in the editor toolbar.
 *
 * @stability experimental
 */
export interface EditorToolbarItem {
  /** Unique among toolbar items. */
  readonly id: string;
  readonly label: string;
  /** Items with the same group sit together. */
  readonly group?: string;
  /** Lower first. Defaults to 0. */
  readonly order?: number;
  isActive?(editor: EditorHandle): boolean;
  run(editor: EditorHandle): void;
}

/**
 * An entry in the editor's slash menu.
 *
 * @stability experimental
 */
export interface EditorSlashItem {
  /** Unique among slash items. */
  readonly id: string;
  readonly label: string;
  /** Extra words the menu filter matches. */
  readonly keywords?: readonly string[];
  readonly order?: number;
  /** Runs after the `/query` text has been removed. */
  run(editor: EditorHandle): void;
}

/**
 * The editor schema as plain data, for a server that reads or writes the
 * shared document without a ProseMirror schema. Each node and mark maps its
 * attribute names, in schema order, to their defaults (`null` when there is
 * none); marks are listed in schema order.
 *
 * @stability experimental
 */
export interface EditorSchemaDescription {
  readonly nodes: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly marks: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The marks that do not exclude themselves, so one text can carry several of them. */
  readonly overlappingMarks: readonly string[];
}

/** The page an editor opens, as {@link EditorCollaborationProvider}s see it. */
export interface EditorCollaborationTarget {
  readonly orgId: string;
  readonly spaceId: string;
  readonly branch: string;
  readonly entryId: string;
  /** The schema of the editor that asks. */
  readonly schema?: EditorSchemaDescription;
}

/**
 * A shared editing session for one page. The editor binds to `fragment` of
 * `document` instead of loading the stored body, stops saving on its own
 * (the provider persists the document), and shows the other users of
 * `awareness`.
 */
export interface EditorCollaborationSession {
  /** A Yjs `Doc`, from the `yjs` module of the host's import map. */
  readonly document: unknown;
  /** The name of the `XmlFragment` that holds this page's body. */
  readonly fragment: string;
  /** A provider with a Yjs `awareness`, for remote cursors and presence. */
  readonly provider: unknown;
  /** How this user appears to others. */
  readonly user: { readonly name: string; readonly color: string };
  /** Resolves once the document has the server's state. */
  readonly synced: Promise<void>;
  /** Asks the provider to store a revision now (on an explicit save). */
  save(): Promise<void>;
  dispose(): void;
}

/**
 * Starts a shared editing session for a page, or returns `undefined` to
 * leave the page in single-user mode.
 */
export type EditorCollaborationProvider = (
  target: EditorCollaborationTarget,
) => Promise<EditorCollaborationSession | undefined>;

/**
 * The block editor in the browser, provided by the editor plugin's `editor`
 * entry. The high-level API registers blocks, inline nodes, toolbar and slash
 * items; `registerExtension` adds raw Tiptap extensions. The core schema
 * (`doc`, `paragraph`, `text`, the core marks) and passthrough nodes for
 * anything the schema cannot show are always present. Every register call
 * returns a function that removes the registration, and registrations made
 * through a plugin's `ctx` are removed when the plugin unloads. Editors open
 * at that time are rebuilt.
 *
 * @stability experimental
 */
export interface EditorService {
  /** Throws when `type` is already registered. */
  registerBlock(definition: EditorBlockDefinition): () => void;
  /** Throws when `type` is already registered. */
  registerInline(definition: EditorInlineDefinition): () => void;
  /** Throws when `type` is already registered. */
  registerMark(definition: EditorMarkDefinition): () => void;
  registerToolbarItem(item: EditorToolbarItem): () => void;
  registerSlashItem(item: EditorSlashItem): () => void;
  /** Adds a raw Tiptap extension (an `Extension`, `Node` or `Mark`). */
  registerExtension(extension: unknown): () => void;
  /**
   * Registers a collaboration provider. When a page opens, the editor asks
   * the providers in registration order; the first session returned is used.
   */
  registerCollaboration(provider: EditorCollaborationProvider): () => void;
}
