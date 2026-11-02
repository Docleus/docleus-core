import { DocleusError, type Context, type DocleusPlugin } from "@docleus/sdk";

type Fiber = Awaited<ReturnType<Context["plugin"]>>;

export interface EditorEntry {
  readonly name: string;
  readonly url: string;
}

export type ModuleImporter = (url: string) => Promise<unknown>;

const browserImport: ModuleImporter = (url) => import(/* @vite-ignore */ url);

function pluginOf(entry: EditorEntry, module: unknown): DocleusPlugin {
  const plugin = (module as { plugin?: unknown } | null)?.plugin;
  if (
    typeof plugin !== "object" ||
    plugin === null ||
    typeof (plugin as { apply?: unknown }).apply !== "function"
  ) {
    throw new DocleusError(
      "plugin/no-plugin-export",
      `${entry.name}: ${entry.url} does not export "plugin"`,
    );
  }
  return plugin as DocleusPlugin;
}

/**
 * Keeps the plugins mounted on `root` equal to a list of editor entries:
 * entries that left the list are unloaded (undoing everything they
 * registered), new ones are imported and mounted. Calls run in order.
 */
export function createPluginLoader(
  root: Context,
  importModule: ModuleImporter = browserImport,
) {
  const mounted = new Map<string, Fiber>();
  let queue: Promise<void> = Promise.resolve();

  async function applyNow(entries: readonly EditorEntry[]): Promise<void> {
    const wanted = new Map(entries.map((entry) => [entry.url, entry]));
    for (const [url, fiber] of mounted) {
      if (wanted.has(url)) continue;
      mounted.delete(url);
      await fiber.dispose();
    }
    for (const [url, entry] of wanted) {
      if (mounted.has(url)) continue;
      const plugin = pluginOf(entry, await importModule(url));
      mounted.set(url, await root.plugin(plugin as never, undefined as never));
    }
  }

  return {
    apply(entries: readonly EditorEntry[]): Promise<void> {
      const run = queue.then(() => applyNow(entries));
      queue = run.catch(() => undefined);
      return run;
    },
    get urls(): string[] {
      return [...mounted.keys()];
    },
  };
}
