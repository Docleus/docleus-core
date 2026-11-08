import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DocleusError,
  applyPatch,
  type ConfigPatchRow,
  type ConfigRow,
  type Context,
} from "@docleus/kernel";
import type { CoreProviders } from "./core-providers.ts";
import {
  configRelativePath,
  deploymentPatch,
  readDeploymentConfig,
  writeDeploymentPlugins,
  type DeploymentPluginRow,
  type PluginSource,
} from "./deployment-config.ts";
import type { Frontend, MountedPlugin } from "./frontend.ts";
import type { PluginHost } from "./host.ts";
import { removeShippedHostModules } from "./host-modules.ts";
import { createInstallLock, type InstallLockOptions } from "./install-lock.ts";
import {
  stagePlugin,
  type InstallRequest,
  type StageOptions,
} from "./plugin-source.ts";
import {
  createLocalManifestReader,
  resolvePluginDir,
} from "./resolve-plugin.ts";

/** A mounted plugin as the instance admin sees it. */
export interface ListedPlugin {
  readonly name: string;
  readonly version: string;
  readonly hasEditor: boolean;
  /** Installed at runtime (and removable); `false` for plugins of the bundle. */
  readonly isInstalled: boolean;
  readonly source?: PluginSource;
  readonly sha256?: string;
}

export interface PluginManager {
  /** The composed plugin rows the host runs. */
  rows(): ConfigRow[];
  list(): ListedPlugin[];
  /**
   * Stages, checks and mounts a plugin without a restart, then records it
   * in the deployment config. Installing the installed version again with
   * the same contents changes nothing; other contents or another version
   * replace it. A plugin whose manifest `provides` a core key replaces the
   * core provider, and whatever injects the key restarts on it.
   *
   * Installs and uninstalls run one at a time across every process on the
   * database, each on the deployment config as the file holds it then.
   * A failed database record restores the previous runtime and config.
   * If restoration fails too, files are retained for manual recovery and
   * the operation rejects with `plugin/rollback-failed`.
   */
  install(request: InstallRequest): Promise<ListedPlugin>;
  /** Unmounts a runtime-installed plugin, forgets its settings and removes its files. */
  uninstall(name: string): Promise<void>;
}

export interface PluginManagerOptions extends StageOptions {
  readonly ctx: Context;
  readonly host: PluginHost;
  /** The core providers a plugin's `provides` replaces. */
  readonly core: CoreProviders;
  /** What the bundle's plugin specifiers resolve against. */
  readonly baseDir: string;
  readonly plugins: Map<string, MountedPlugin>;
  readonly frontend: Frontend;
  /** The bundle's rows, which the deployment rows patch. */
  readonly bundle: readonly ConfigRow[];
  readonly deployment: readonly DeploymentPluginRow[];
  /** Where installs are recorded; installs only last until shutdown without it. */
  readonly configFile?: string;
  /** Holds `<name>@<version>-<hash>` directories of installed plugins. */
  readonly pluginsDir: string;
  readonly lock?: InstallLockOptions;
}

/**
 * Unique per contents, so that a reinstall imports the server entry from a
 * new URL: Node's module cache would otherwise keep running the old code.
 */
function installDirName(name: string, version: string, sha256: string): string {
  return `${name.replaceAll("/", "+")}@${version}-${sha256.slice(0, 12)}`;
}

function providedBy(mounted: ReadonlyMap<string, MountedPlugin>): string[] {
  return [...mounted.values()].flatMap(({ manifest }) => manifest.provides);
}

function isInstalledRow(row: DeploymentPluginRow): boolean {
  return row.source !== undefined;
}

/** Composes the bundle with the deployment rows of a config file. */
export function composePluginRows(
  bundle: readonly ConfigRow[],
  deployment: readonly DeploymentPluginRow[],
  configFile: string | undefined,
): ConfigRow[] {
  const patch: ConfigPatchRow[] = configFile
    ? deploymentPatch(configFile, deployment)
    : deployment.map((row) => ({
        id: row.id,
        ...(row.plugin !== undefined && { plugin: resolve(row.plugin) }),
        ...(row.config !== undefined && { config: row.config }),
        ...(row.disabled !== undefined && { disabled: row.disabled }),
      }));
  return applyPatch(bundle, patch, configFile ?? "deployment");
}

export function createPluginManager(
  options: PluginManagerOptions,
): PluginManager {
  const { ctx, host, core, plugins, frontend, configFile, pluginsDir } =
    options;
  const logger = ctx.logger("plugins");
  const readManifest = createLocalManifestReader(options.baseDir);
  const lock = createInstallLock(ctx, options.lock);
  let deployment = [...options.deployment];
  let queue: Promise<unknown> = Promise.resolve();

  const compose = (rows: readonly DeploymentPluginRow[]) =>
    composePluginRows(options.bundle, rows, configFile);

  /** One at a time in this process, then one at a time across processes. */
  function serially<T>(
    task: (base: readonly DeploymentPluginRow[]) => Promise<T>,
  ): Promise<T> {
    const run = queue.then(() =>
      lock.run(() =>
        // Another process may have installed or removed plugins since this
        // one last read the file; building on a stale list would drop them.
        task(
          configFile ? readDeploymentConfig(configFile).plugins : deployment,
        ),
      ),
    );
    queue = run.catch(() => undefined);
    return run;
  }

  function mountedOf(rows: readonly DeploymentPluginRow[]) {
    const mounted = new Map<string, MountedPlugin>();
    for (const row of compose(rows)) {
      if (row.disabled) continue;
      const manifest = readManifest(row.plugin);
      mounted.set(manifest.name, {
        manifest,
        dir: resolvePluginDir(options.baseDir, row.plugin),
      });
    }
    return mounted;
  }

  /**
   * Mounts `next`: the core providers of keys a plugin of `next` provides
   * go first, so that the plugin can provide the key, and the providers of
   * keys no plugin provides any more come back after.
   */
  async function mount(
    next: readonly DeploymentPluginRow[],
    base: readonly DeploymentPluginRow[] = deployment,
    record?: () => Promise<void>,
  ): Promise<void> {
    const before = providedBy(plugins);
    const after = providedBy(mountedOf(next));
    try {
      await core.sync([...before, ...after]);
      await host.apply(compose(next));
      await core.sync(after);
      await save(next);
      await record?.();
    } catch (error) {
      try {
        const restored = providedBy(mountedOf(base));
        await core.sync([...before, ...after, ...restored]);
        await host.apply(compose(base));
        await core.sync(restored);
        await save(base);
        adopt([...base]);
      } catch (rollback) {
        logger.error(
          "cannot restore plugins after a failed change: %s",
          rollback,
        );
        throw new DocleusError(
          "plugin/rollback-failed",
          "cannot restore plugins after a failed change; retain the plugin files for recovery",
          { cause: new AggregateError([error, rollback]) },
        );
      }
      throw error;
    }
  }

  function adopt(next: DeploymentPluginRow[]): void {
    deployment = next;
    const mounted = mountedOf(next);
    plugins.clear();
    for (const [name, plugin] of mounted) plugins.set(name, plugin);
    frontend.refresh();
  }

  function present(name: string, plugin: MountedPlugin): ListedPlugin {
    const row = deployment.find((r) => r.id === name && isInstalledRow(r));
    return {
      name,
      version: plugin.manifest.version,
      hasEditor: plugin.manifest.entries.editor !== undefined,
      isInstalled: row !== undefined,
      ...(row?.source && { source: row.source }),
      ...(row?.sha256 && { sha256: row.sha256 }),
    };
  }

  async function save(rows: readonly DeploymentPluginRow[]): Promise<void> {
    if (configFile) await writeDeploymentPlugins(configFile, rows);
  }

  async function install(
    request: InstallRequest,
    base: readonly DeploymentPluginRow[],
  ): Promise<ListedPlugin> {
    const staging = join(pluginsDir, `.staging-${randomUUID()}`);
    let target: string | undefined;
    try {
      const staged = await stagePlugin(staging, request, options);
      const { name, version } = staged.manifest;
      const previous = base.find(
        (row) => row.id === name && isInstalledRow(row),
      );
      const current = mountedOf(base);
      const mounted = current.get(name);
      if (mounted && !previous) {
        throw new DocleusError(
          "plugin/already-installed",
          `${name} is part of the bundle; change its row in the deployment config instead`,
        );
      }
      const dir = join(
        pluginsDir,
        installDirName(name, version, staged.sha256),
      );
      if (previous?.sha256 === staged.sha256 && mounted?.dir === dir) {
        // Installed with these contents already, by this process or another.
        if (plugins.get(name)?.dir !== dir) {
          await mount(base, base);
          adopt([...base]);
        }
        return present(name, mounted);
      }

      const nextPlugins = new Map(current);
      nextPlugins.set(name, { manifest: staged.manifest, dir });
      frontend.check(nextPlugins);

      await removeShippedHostModules(staging);
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      target = dir;

      const row: DeploymentPluginRow = {
        id: name,
        plugin: configFile ? configRelativePath(configFile, dir) : dir,
        ...(previous?.config !== undefined && { config: previous.config }),
        version,
        source: staged.source,
        sha256: staged.sha256,
      };
      const next = previous
        ? base.map((r) => (r === previous ? row : r))
        : [...base, row];
      await mount(next, base, () => ctx.installations.install(name));
      adopt(next);
      target = undefined;
      if (mounted && mounted.dir !== dir) {
        await rm(mounted.dir, { recursive: true, force: true });
      }
      logger.info("installed %s@%s", name, version);
      return present(name, { manifest: staged.manifest, dir });
    } catch (error) {
      if (
        error instanceof DocleusError &&
        error.code === "plugin/rollback-failed"
      ) {
        target = undefined;
      }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (target) await rm(target, { recursive: true, force: true });
    }
  }

  async function uninstall(
    name: string,
    base: readonly DeploymentPluginRow[],
  ): Promise<void> {
    const row = base.find((r) => r.id === name && isInstalledRow(r));
    const mounted = mountedOf(base).get(name);
    if (!row) {
      throw mounted
        ? new DocleusError(
            "plugin/bundled",
            `${name} is part of the bundle; disable its row in the deployment config instead`,
          )
        : new DocleusError(
            "plugin/not-installed",
            `plugin "${name}" is not installed`,
          );
    }
    const next = base.filter((r) => r !== row);
    await mount(next, base, () => ctx.installations.uninstall(name));
    adopt(next);
    if (mounted) await rm(mounted.dir, { recursive: true, force: true });
    logger.info("uninstalled %s", name);
  }

  return {
    rows: () => compose(deployment),
    list: () => [...plugins].map(([name, plugin]) => present(name, plugin)),
    install: (request) => serially((base) => install(request, base)),
    uninstall: (name) => serially((base) => uninstall(name, base)),
  };
}
