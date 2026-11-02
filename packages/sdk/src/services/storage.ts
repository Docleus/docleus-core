import type { Kysely } from "kysely";

/** One step of a plugin's schema, applied once by `storage.migrate`. */
export interface Migration {
  readonly id: string;
  up(db: Kysely<unknown>): Promise<void>;
}

/** The SQL database behind {@link StorageService}. */
export type StorageDialect = "sqlite" | "postgres";

/**
 * The shared SQL database (SQLite or Postgres) through Kysely, with per-owner migrations.
 *
 * @stability experimental
 */
export interface StorageService {
  /** The database in use, for the few queries that differ between dialects (such as full-text search). */
  readonly dialect: StorageDialect;
  readonly db: Kysely<unknown>;
  /**
   * Applies each migration once per owner, in order, each in its own
   * transaction. The service's own disposal waits for the most recently
   * started call before closing the connection, so callers do not need to
   * await it themselves purely to avoid a disposal race.
   */
  migrate(owner: string, migrations: readonly Migration[]): Promise<void>;
  /** Runs `fn` in a transaction; any throw rolls back every change made inside. */
  transaction<T>(fn: (db: Kysely<unknown>) => Promise<T>): Promise<T>;
}
