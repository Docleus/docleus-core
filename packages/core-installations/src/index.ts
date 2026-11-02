import { Context, DocleusError } from "@docleus/kernel";
import {
  scopeKey,
  type DispatchScope,
  type InstallationsService,
  type Scope,
} from "@docleus/sdk";
import type { Kysely } from "kysely";
import { installationsMigrations, type InstallationsSchema } from "./schema.ts";

/** Scope keys from nearest to farthest, excluding instance (which holds no overrides). */
function overrideChain(scope: Scope): string[] {
  if (scope.kind === "instance") return [];
  if (scope.kind === "org") return [scopeKey(scope)];
  return [scopeKey(scope), scopeKey({ kind: "org", orgId: scope.orgId })];
}

function assertNotInstance(scope: Scope, operation: string): void {
  if (scope.kind === "instance") {
    throw new DocleusError(
      "installations/instance-scope",
      `${operation} needs an org or space scope; instance-level choices live in the deployment config`,
    );
  }
}

/**
 * Default `installations` implementation on top of `ctx.storage`.
 * `scope()` returns an object usable as the `thisArg` of Cordis dispatch
 * (`ctx.emit(scope, name, ...args)`), which skips listeners whose owning
 * plugin is installed but not enabled in that scope.
 *
 * @stability experimental
 */
export function createInstallationsService(ctx: Context): InstallationsService {
  const db = ctx.storage.db as unknown as Kysely<InstallationsSchema>;
  const ready = ctx.storage.migrate(
    "@docleus/core-installations",
    installationsMigrations,
  );

  async function isInstalled(plugin: string): Promise<boolean> {
    await ready;
    const row = await db
      .selectFrom("installations")
      .select("plugin")
      .where("plugin", "=", plugin)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function assertInstalled(plugin: string): Promise<void> {
    if (!(await isInstalled(plugin))) {
      throw new DocleusError(
        "installations/not-installed",
        `plugin "${plugin}" is not installed`,
      );
    }
  }

  /** Effective enablement of every installed plugin in `scope`. */
  async function loadEnablement(scope: Scope): Promise<Map<string, boolean>> {
    await ready;
    const chain = overrideChain(scope);
    const installed = await db
      .selectFrom("installations")
      .select("plugin")
      .execute();
    const result = new Map<string, boolean>(
      installed.map(({ plugin }) => [plugin, scope.kind === "instance"]),
    );
    if (chain.length === 0) return result;
    const overrides = await db
      .selectFrom("plugin_enablement")
      .selectAll()
      .where("scope_key", "in", chain)
      .execute();
    for (const key of chain.toReversed()) {
      for (const row of overrides) {
        if (row.scope_key === key) result.set(row.plugin, row.enabled === 1);
      }
    }
    return result;
  }

  return {
    async install(plugin) {
      await ready;
      await db
        .insertInto("installations")
        .values({ plugin, installed_at: Date.now() })
        .onConflict((oc) => oc.column("plugin").doNothing())
        .execute();
    },
    async uninstall(plugin) {
      await ready;
      await ctx.storage.transaction(async (trx) => {
        const typed = trx as unknown as Kysely<InstallationsSchema>;
        await typed
          .deleteFrom("plugin_enablement")
          .where("plugin", "=", plugin)
          .execute();
        await typed
          .deleteFrom("plugin_settings")
          .where("plugin", "=", plugin)
          .execute();
        await typed
          .deleteFrom("installations")
          .where("plugin", "=", plugin)
          .execute();
      });
    },
    isInstalled,
    async listInstalled() {
      await ready;
      const rows = await db
        .selectFrom("installations")
        .select("plugin")
        .orderBy("plugin")
        .execute();
      return rows.map((row) => row.plugin);
    },
    async setEnabled(plugin, scope, enabled) {
      assertNotInstance(scope, "setEnabled");
      const key = scopeKey(scope);
      await assertInstalled(plugin);
      if (enabled === undefined) {
        await db
          .deleteFrom("plugin_enablement")
          .where("plugin", "=", plugin)
          .where("scope_key", "=", key)
          .execute();
        return;
      }
      const value = enabled ? 1 : 0;
      await db
        .insertInto("plugin_enablement")
        .values({ plugin, scope_key: key, enabled: value })
        .onConflict((oc) =>
          oc.columns(["plugin", "scope_key"]).doUpdateSet({ enabled: value }),
        )
        .execute();
    },
    async isEnabled(plugin, scope) {
      return (await loadEnablement(scope)).get(plugin) ?? false;
    },
    async setSettings(plugin, scope, settings) {
      assertNotInstance(scope, "setSettings");
      const key = scopeKey(scope);
      await assertInstalled(plugin);
      const serialized = JSON.stringify(settings) as string | undefined;
      if (serialized === undefined) {
        await db
          .deleteFrom("plugin_settings")
          .where("plugin", "=", plugin)
          .where("scope_key", "=", key)
          .execute();
        return;
      }
      await db
        .insertInto("plugin_settings")
        .values({ plugin, scope_key: key, settings: serialized })
        .onConflict((oc) =>
          oc
            .columns(["plugin", "scope_key"])
            .doUpdateSet({ settings: serialized }),
        )
        .execute();
    },
    async getSettings(plugin, scope) {
      await ready;
      for (const key of overrideChain(scope)) {
        const row = await db
          .selectFrom("plugin_settings")
          .select("settings")
          .where("plugin", "=", plugin)
          .where("scope_key", "=", key)
          .executeTakeFirst();
        if (row) return JSON.parse(row.settings) as unknown;
      }
      return undefined;
    },
    async scope(scope) {
      const enablement = await loadEnablement(scope);
      const allows = (plugin: string): boolean =>
        enablement.get(plugin) ?? true;
      const dispatchScope: DispatchScope & {
        readonly [filter: symbol]: unknown;
      } = {
        allows,
        [Context.filter]: (target: Context) => allows(target.fiber.name),
      };
      return dispatchScope;
    },
  };
}

export function provideInstallations(ctx: Context): () => void {
  return ctx.provide("installations", createInstallationsService(ctx));
}
