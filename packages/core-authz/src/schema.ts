import type { Kysely } from "kysely";

export interface GrantsTable {
  user_id: string;
  scope_key: string;
  role: string;
}

export interface AuthzSchema {
  authz_grants: GrantsTable;
}

export const authzMigrations = [
  {
    id: "0001-create-grants",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<AuthzSchema>;
      await typed.schema
        .createTable("authz_grants")
        .ifNotExists()
        .addColumn("user_id", "text", (c) => c.notNull())
        .addColumn("scope_key", "text", (c) => c.notNull())
        .addColumn("role", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("authz_grants_pk", ["user_id", "scope_key"])
        .execute();
    },
  },
];
