import type { BlockNode } from "./blocks.ts";
import type { Scope } from "./scope.ts";

/**
 * A React function component. Typed without React so the SDK has no React
 * dependency; plugin frontends get React from the host's import map.
 */
export type UiComponent<Props> = (props: Props) => unknown;

/** Props of the page editor, which the host renders in the `page.editor` slot. */
export interface PageEditorProps {
  readonly orgId: string;
  readonly spaceId: string;
  readonly entryId: string;
  /** The branch the page was loaded from and saves go to. */
  readonly branch: string;
  /** The page body as stored, migrated to current block versions. */
  readonly body: BlockNode;
  /** Saves ProseMirror JSON (see `fromEditorDocument`) as a new revision. */
  save(document: unknown): Promise<void>;
  /**
   * `false` in a space's live view: the editor shows the body without
   * editing, opens no collaboration session and never saves. Defaults to
   * `true`.
   */
  readonly isEditable?: boolean;
  /** Called whenever the save state changes, so the host can show it. */
  onSaveState?(state: SaveState): void;
}

/** Where the page editor's changes are, as the host shows it in the top bar. */
export type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving" }
  | { readonly kind: "error"; readonly message: string };

/** Props of slots that belong to a space. */
export interface SpaceSlotProps {
  readonly orgId: string;
  readonly spaceId: string;
  /** The branch the space is shown at; `main` unless the URL has `?branch=`. */
  readonly branch: string;
  /** Shows the space at another branch (`main` to leave a branch). */
  openBranch(name: string): void;
}

/** Props of slots that belong to a page. */
export interface PageSlotProps extends SpaceSlotProps {
  readonly entryId: string;
}

/** Props of the `space.bar` slot: actions in the space's top bar. */
export interface SpaceBarProps extends SpaceSlotProps {
  /** The page shown, if any. */
  readonly entryId: string | undefined;
  /** Whether the space is in edit mode rather than the read-only view. */
  readonly isEditing: boolean;
  /** The `space.view` shown instead of the page, if any. */
  readonly view: string | undefined;
  /** Shows a `space.view` by id, or the page again with `undefined`. */
  openView(id: string | undefined): void;
  /** The `space.panel` open beside the page, if any. */
  readonly panel: string | undefined;
  /** Opens a `space.panel` by id, or closes it with `undefined`. */
  openPanel(id: string | undefined): void;
  /** Leaves edit mode and shows the space at `main`. */
  stopEditing(): void;
  /**
   * Runs `task` when the user leaves edit mode with Done, before the space
   * switches to `main`; the host waits for it. Returns a function that
   * removes the task. A plugin uses it to drop a draft that has no changes.
   */
  onStopEditing(task: () => Promise<void>): () => void;
}

/** Props of a `space.view`. */
export interface SpaceViewProps extends SpaceSlotProps {
  readonly entryId: string | undefined;
  /** Shows the page again. */
  close(): void;
}

/** Props of slots on an organization's home. */
export interface OrgSlotProps {
  readonly orgId: string;
}

/** What the host passes to {@link EditBranchResolver}s. */
export interface EditBranchContext {
  readonly orgId: string;
  readonly spaceId: string;
  /** The page being edited; `undefined` for writes to the page tree that are not about one page. */
  readonly entryId: string | undefined;
}

/**
 * Picks the branch a write goes to when the user starts changing a space
 * shown at `main`. Returns a branch name, or `undefined` to leave the
 * write on `main`.
 */
export type EditBranchResolver = (
  context: EditBranchContext,
) => Promise<string | undefined>;

/**
 * The UI slots of the host and their props. Plugins add slots of their own
 * by augmenting this interface (`declare module "@docleus/sdk"`), with
 * namespaced names.
 */
export interface UiSlots {
  /** The page body editor. The host renders the first item only. */
  "page.editor": PageEditorProps;
  "page.header": PageSlotProps;
  "page.footer": PageSlotProps;
  sidebar: SpaceSlotProps;
  /** Actions in the space's top bar, left of the host's Edit and Done. */
  "space.bar": SpaceBarProps;
  /** A view that replaces the page while the URL has `?view=<item id>`. */
  "space.view": SpaceViewProps;
  /** A side panel beside the page while the URL has `?panel=<item id>`. */
  "space.panel": SpaceViewProps;
  /** Sections above the spaces on an organization's home. */
  "org.home": OrgSlotProps;
}

/** A component that a plugin adds to a UI slot. */
export interface UiSlotItem<Props> {
  /** Unique within the slot. */
  readonly id: string;
  /** Lower first. Defaults to 0. */
  readonly order?: number;
  readonly component: UiComponent<Props>;
}

/** Props of a settings page. */
export interface SettingsPageProps {
  readonly scope: Scope;
}

/**
 * A settings page that a plugin adds at the instance, org or space level.
 */
export interface UiSettingsPage {
  /** Unique; the page's URL segment. */
  readonly id: string;
  readonly label: string;
  /** The settings levels the page appears at. */
  readonly scopes: readonly Scope["kind"][];
  readonly order?: number;
  readonly component: UiComponent<SettingsPageProps>;
}

/** A full-page app at `/apps/<plugin>/...`. */
export interface UiApp {
  /** The URL segment after `/apps/`; by convention the plugin's short name. */
  readonly path: string;
  readonly label: string;
  /** Receives the rest of the path after `/apps/<path>`. */
  readonly component: UiComponent<{ readonly path: string }>;
}

/** Where the command palette is opened. */
export interface CommandContext {
  readonly orgId: string | undefined;
  readonly spaceId: string | undefined;
  readonly entryId: string | undefined;
  readonly branch: string;
}

/**
 * A command in the palette (⌘K).
 *
 * @stability experimental
 */
export interface UiCommand {
  /** Unique among commands. */
  readonly id: string;
  readonly label: string;
  /** Extra words the palette filter matches. */
  readonly keywords?: readonly string[];
  /** Whether the command applies where the palette was opened. Defaults to always. */
  isAvailable?(context: CommandContext): boolean;
  run(context: CommandContext): void | Promise<void>;
}

/** A result a {@link UiSearchProvider} returns. */
export interface UiSearchResult {
  readonly id: string;
  readonly label: string;
  /** A second line, such as the page's space or a matching sentence. */
  readonly detail?: string;
  /** Where choosing the result goes; an app path such as `/orgs/…/pages/…`. */
  readonly href: string;
}

/**
 * Returns palette results for `query`; asked on each keystroke, so it
 * should honour `signal`.
 */
export type UiSearchProvider = (
  query: string,
  context: CommandContext & { readonly signal: AbortSignal },
) => Promise<readonly UiSearchResult[]>;

/** A draft the user can resume, as an {@link EditDraftFinder} finds it. */
export interface EditDraft {
  readonly branch: string;
  /** A short name for the top bar, such as `Draft #14`. */
  readonly label: string;
}

/**
 * Finds the draft the user would continue in a space, without creating
 * one, or returns `undefined`.
 */
export type EditDraftFinder = (context: {
  readonly orgId: string;
  readonly spaceId: string;
}) => Promise<EditDraft | undefined>;

/** A toast shown by {@link UiService.notify}. */
export interface UiNotice {
  /** One line, the verb first: `Merged #14`. */
  readonly message: string;
  readonly action?: { readonly label: string; run(): void };
}

/**
 * The browser host: UI slots, settings pages, full-page apps, and requests
 * to the instance API. Provided by `@docleus/app` to the `editor` entries of
 * the plugins enabled in the current space. Registrations made through a
 * plugin's `ctx` are removed when the plugin unloads.
 *
 * @stability experimental
 */
export interface UiService {
  /** Throws when `item.id` is already registered in `slot`. */
  registerSlot<Slot extends keyof UiSlots>(
    slot: Slot,
    item: UiSlotItem<UiSlots[Slot]>,
  ): () => void;
  /** Items of `slot` in order. */
  slot<Slot extends keyof UiSlots>(slot: Slot): UiSlotItem<UiSlots[Slot]>[];
  /** Throws when `page.id` is already registered. */
  registerSettingsPage(page: UiSettingsPage): () => void;
  /** Throws when `app.path` is already registered. */
  registerApp(app: UiApp): () => void;
  /**
   * Before the first write (saving a body, creating, renaming, moving or
   * deleting a page) to a space shown at `main`, the host asks the
   * resolvers in registration order; the first branch name returned wins,
   * the write goes to that branch, and the space switches to it.
   */
  registerEditBranch(resolver: EditBranchResolver): () => void;
  /** Throws when `command.id` is already registered. */
  registerCommand(command: UiCommand): () => void;
  /** Adds results to the palette; providers are asked in parallel. */
  registerSearch(provider: UiSearchProvider): () => void;
  /**
   * Before showing Edit in a space's live view, the host asks the finders in
   * registration order; the first draft found turns Edit into Continue
   * editing, which opens that branch.
   */
  registerEditDraft(finder: EditDraftFinder): () => void;
  /** Shows a toast. */
  notify(notice: UiNotice): void;
  /** `fetch` against the instance with the signed-in user's credentials. */
  request(path: string, init?: RequestInit): Promise<Response>;
}
