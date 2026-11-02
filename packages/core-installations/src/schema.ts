import type { Kysely } from "kysely";

export interface InstallationsTable {
  plugin: string;
  installed_at: number;
}

export interface PluginEnablementTable {
  plugin: string;
  scope_key: string;
  enabled: number;
}

export interface PluginSettingsTable {
  plugin: string;
  scope_key: string;
  settings: string;
}

export interface InstallationsSchema {
  installations: InstallationsTable;
  plugin_enablement: PluginEnablementTable;
  plugin_settings: PluginSettingsTable;
}

export const installationsMigrations = [
  {
    id: "0001-create-tables",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<InstallationsSchema>;
      await typed.schema
        .createTable("installations")
        .ifNotExists()
        .addColumn("plugin", "text", (c) => c.primaryKey())
        .addColumn("installed_at", "integer", (c) => c.notNull())
        .execute();
      await typed.schema
        .createTable("plugin_enablement")
        .ifNotExists()
        .addColumn("plugin", "text", (c) =>
          c.notNull().references("installations.plugin"),
        )
        .addColumn("scope_key", "text", (c) => c.notNull())
        .addColumn("enabled", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint("plugin_enablement_pk", [
          "plugin",
          "scope_key",
        ])
        .execute();
      await typed.schema
        .createTable("plugin_settings")
        .ifNotExists()
        .addColumn("plugin", "text", (c) =>
          c.notNull().references("installations.plugin"),
        )
        .addColumn("scope_key", "text", (c) => c.notNull())
        .addColumn("settings", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("plugin_settings_pk", ["plugin", "scope_key"])
        .execute();
    },
  },
];
