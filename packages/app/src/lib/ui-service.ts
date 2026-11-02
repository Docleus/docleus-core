import {
  DocleusError,
  trackCaller,
  type Context,
  type EditBranchContext,
  type EditBranchResolver,
  type EditDraft,
  type EditDraftFinder,
  type UiApp,
  type UiCommand,
  type UiNotice,
  type UiSearchProvider,
  type UiService,
  type UiSettingsPage,
  type UiSlotItem,
} from "@docleus/sdk";
import { request } from "./api.ts";

/** The host's `ui` service, plus change notification for React. */
export interface HostUiService extends UiService {
  /** Calls `onChange` after every registration change. */
  subscribe(onChange: () => void): () => void;
  /** Increases with every registration change. */
  version(): number;
  settingsPages(): UiSettingsPage[];
  apps(): UiApp[];
  /**
   * Asks the edit-branch resolvers in registration order and returns the
   * first branch name one returns, or `undefined` when none does. A
   * resolver that throws rejects the whole resolution.
   */
  resolveEditBranch(context: EditBranchContext): Promise<string | undefined>;
  commands(): UiCommand[];
  searchProviders(): UiSearchProvider[];
  /** The first draft a finder returns; finders that throw are skipped. */
  findEditDraft(context: {
    orgId: string;
    spaceId: string;
  }): Promise<EditDraft | undefined>;
  /** Calls `onNotice` for every `notify`. */
  onNotice(onNotice: (notice: UiNotice) => void): () => void;
}

const byOrder = <T extends { readonly order?: number }>(a: T, b: T) =>
  (a.order ?? 0) - (b.order ?? 0);

/** The default `ui` implementation provided by `@docleus/app`. */
export function createUiService(ctx: Context): HostUiService {
  const slots = new Map<string, Map<string, UiSlotItem<never>>>();
  const settings = new Map<string, UiSettingsPage>();
  const apps = new Map<string, UiApp>();
  const editBranchResolvers: EditBranchResolver[] = [];
  const commands = new Map<string, UiCommand>();
  const searchProviders: UiSearchProvider[] = [];
  const draftFinders: EditDraftFinder[] = [];
  const noticeListeners = new Set<(notice: UiNotice) => void>();
  const listeners = new Set<() => void>();
  let version = 0;

  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };

  function addToList<T>(
    caller: Context,
    list: T[],
    value: T,
    what: string,
  ): () => void {
    return caller.effect(() => {
      list.push(value);
      changed();
      return () => {
        const index = list.indexOf(value);
        if (index >= 0) list.splice(index, 1);
        changed();
      };
    }, `ctx.ui ${what}`);
  }

  function add<T>(
    caller: Context,
    registry: Map<string, T>,
    key: string,
    value: T,
    what: string,
  ): () => void {
    return caller.effect(
      () => {
        if (registry.has(key)) {
          throw new DocleusError(
            "ui/already-registered",
            `${what} "${key}" is already registered`,
          );
        }
        registry.set(key, value);
        changed();
        return () => {
          registry.delete(key);
          changed();
        };
      },
      `ctx.ui ${what} ${JSON.stringify(key)}`,
    );
  }

  return trackCaller<HostUiService>(ctx, {
    registerSlot(slot, item) {
      let registry = slots.get(slot);
      if (!registry) {
        registry = new Map();
        slots.set(slot, registry);
      }
      return add(
        this.ctx,
        registry,
        item.id,
        item as UiSlotItem<never>,
        `slot item in "${slot}"`,
      );
    },
    slot(slot) {
      return [...(slots.get(slot)?.values() ?? [])].toSorted(byOrder) as never;
    },
    registerSettingsPage(page) {
      return add(this.ctx, settings, page.id, page, "settings page");
    },
    registerApp(app) {
      return add(this.ctx, apps, app.path, app, "app");
    },
    registerEditBranch(resolver) {
      return this.ctx.effect(() => {
        editBranchResolvers.push(resolver);
        return () => {
          const index = editBranchResolvers.indexOf(resolver);
          if (index >= 0) editBranchResolvers.splice(index, 1);
        };
      }, "ctx.ui edit branch resolver");
    },
    async resolveEditBranch(context) {
      // A snapshot: a resolver may load or unload plugins.
      for (const resolver of editBranchResolvers.slice()) {
        const branch = await resolver(context);
        if (branch !== undefined) return branch;
      }
      return undefined;
    },
    registerCommand(command) {
      return add(this.ctx, commands, command.id, command, "command");
    },
    registerSearch(provider) {
      return addToList(this.ctx, searchProviders, provider, "search provider");
    },
    registerEditDraft(finder) {
      return addToList(this.ctx, draftFinders, finder, "edit draft finder");
    },
    notify(notice) {
      for (const listener of noticeListeners) listener(notice);
    },
    onNotice(onNotice) {
      noticeListeners.add(onNotice);
      return () => noticeListeners.delete(onNotice);
    },
    commands: () => [...commands.values()],
    searchProviders: () => [...searchProviders],
    async findEditDraft(context) {
      for (const finder of draftFinders.slice()) {
        // A finder that fails leaves the user with plain Edit, which still
        // goes through the edit-branch resolvers.
        const draft = await finder(context).catch(() => undefined);
        if (draft) return draft;
      }
      return undefined;
    },
    request: (path, init) => request(path, init),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    version: () => version,
    settingsPages: () => [...settings.values()].toSorted(byOrder),
    apps: () => [...apps.values()],
  });
}
