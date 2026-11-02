import {
  Context,
  DocleusError,
  type ConfigRow,
  type Fiber,
} from "@docleus/kernel";
import {
  findExposeConflicts,
  findIslandConflicts,
  findSyntaxConflicts,
  type DocleusPlugin,
  type Manifest,
} from "@docleus/sdk";

export type PluginResolver = (
  specifier: string,
) => Promise<DocleusPlugin<never>>;

export interface PluginHostOptions {
  /**
   * The manifest of a plugin specifier, used to reject a set of plugins
   * that claim the same syntax or expose the same browser module before any
   * of them is mounted.
   */
  manifest?(
    specifier: string,
  ): Pick<Manifest, "name" | "syntax" | "exposes" | "islands">;
}

interface Mounted {
  row: ConfigRow;
  fiber: Fiber;
}

export class PluginHost {
  private readonly mounted = new Map<string, Mounted>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly ctx: Context,
    private readonly resolve: PluginResolver,
    private readonly options: PluginHostOptions = {},
  ) {}

  get ids(): string[] {
    return [...this.mounted.keys()];
  }

  /** Overlapping calls run one after another, in call order. */
  apply(rows: readonly ConfigRow[]): Promise<void> {
    const run = this.queue.then(() => this.applyNow(rows));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyNow(rows: readonly ConfigRow[]): Promise<void> {
    const wanted = new Map(
      rows.filter((row) => !row.disabled).map((row) => [row.id, row]),
    );
    this.checkManifests([...wanted.values()]);

    for (const [id, mounted] of this.mounted) {
      const next = wanted.get(id);
      if (next?.plugin === mounted.row.plugin) continue;
      await mounted.fiber.dispose();
      this.mounted.delete(id);
    }

    for (const [id, row] of wanted) {
      const current = this.mounted.get(id);
      if (current) {
        if (JSON.stringify(current.row.config) !== JSON.stringify(row.config)) {
          await current.fiber.update(row.config);
        }
        current.row = row;
        continue;
      }
      const plugin = await this.load(row);
      const fiber = await this.ctx.plugin(plugin, row.config as never);
      this.mounted.set(id, { row, fiber });
    }
  }

  private checkManifests(rows: readonly ConfigRow[]): void {
    const manifestOf = this.options.manifest;
    if (!manifestOf) return;
    const manifests = rows.map((row) => manifestOf(row.plugin));
    const claimed = findSyntaxConflicts(manifests);
    if (claimed.length > 0) {
      const details = claimed
        .map(({ syntax, plugins }) => `"${syntax}" (${plugins.join(", ")})`)
        .join("; ");
      throw new DocleusError(
        "plugin/syntax-conflict",
        `plugins claim the same syntax: ${details}`,
      );
    }
    const exposed = findExposeConflicts(manifests);
    if (exposed.length > 0) {
      const details = exposed
        .map(
          ({ specifier, plugins }) => `"${specifier}" (${plugins.join(", ")})`,
        )
        .join("; ");
      throw new DocleusError(
        "plugin/expose-conflict",
        `plugins expose the same module: ${details}`,
      );
    }
    const islands = findIslandConflicts(manifests);
    if (islands.length > 0) {
      const details = islands
        .map(({ type, plugins }) => `"${type}" (${plugins.join(", ")})`)
        .join("; ");
      throw new DocleusError(
        "plugin/island-conflict",
        `plugins declare an island for the same block type: ${details}`,
      );
    }
  }

  private async load(row: ConfigRow): Promise<DocleusPlugin<never>> {
    try {
      return await this.resolve(row.plugin);
    } catch (error) {
      throw new DocleusError(
        "plugin/load-failed",
        `cannot load "${row.plugin}" for row "${row.id}"`,
        {
          cause: error,
        },
      );
    }
  }
}
