import type { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteStatement } from "kysely";

/**
 * Adapts Node's built-in `node:sqlite` to the `SqliteDatabase` interface
 * Kysely's `SqliteDialect` expects (modeled on better-sqlite3). The two
 * differ in two ways this adapter bridges: `node:sqlite` statements take
 * spread positional parameters rather than an array, and they have no
 * `reader` flag, so every statement is treated as one (`all`/`iterate` are
 * only ever called by Kysely on statements that return rows).
 */
export function adaptNodeSqlite(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare: (sql: string): SqliteStatement => {
      const statement = db.prepare(sql);
      return {
        reader: true,
        all: (parameters) => statement.all(...(parameters as never[])),
        run: (parameters) => statement.run(...(parameters as never[])),
        iterate: (parameters) => statement.iterate(...(parameters as never[])),
      };
    },
  };
}
