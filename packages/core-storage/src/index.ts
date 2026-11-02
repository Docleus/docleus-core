import { DatabaseSync } from "node:sqlite";
import { DocleusError, type Context } from "@docleus/kernel";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import { Pool, TypeOverrides, types } from "pg";
import type { Migration, StorageDialect, StorageService } from "@docleus/sdk";
import { adaptNodeSqlite } from "./node-sqlite-adapter.ts";
import { postgresPortability } from "./postgres-portability.ts";

const MIGRATIONS_TABLE = "_docleus_migrations";

// Arbitrary but fixed: every Docleus process on the same database must agree on it.
const POSTGRES_LOCK_KEY = 0x646f636c;

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const OTHER_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

interface MigrationsSchema {
  [MIGRATIONS_TABLE]: { key: string };
}

interface Connection {
  readonly dialect: StorageDialect;
  readonly db: Kysely<unknown>;
}

function connectSqlite(path: string): Connection {
  const database = new DatabaseSync(path);
  return {
    dialect: "sqlite",
    db: new Kysely<unknown>({
      dialect: new SqliteDialect({ database: adaptNodeSqlite(database) }),
    }),
  };
}

function connectPostgres(ctx: Context, url: string): Connection {
  // Per pool rather than global (`types.setTypeParser`), so other `pg`
  // users in the process are unaffected. int8 holds ms timestamps and
  // `count(*)`; both fit a JS number, which is what SQLite returns.
  const parsers = new TypeOverrides();
  parsers.setTypeParser(types.builtins.INT8, Number);
  const pool = new Pool({ connectionString: url, types: parsers });
  const logger = ctx.logger("storage");
  // `pg` emits connection errors (a server restart, a terminated backend)
  // on the pool for idle clients and on the client while it is checked
  // out; unlistened, either would crash the process. The query that was
  // running, if any, still rejects, and the pool replaces the client.
  const onError = (error: Error) => {
    logger.warn("postgres connection failed: %s", error.message);
  };
  pool.on("error", onError);
  pool.on("connect", (client) => client.on("error", onError));
  return {
    dialect: "postgres",
    db: new Kysely<unknown>({
      dialect: new PostgresDialect({ pool }),
      plugins: [postgresPortability],
    }),
  };
}

function connect(ctx: Context, location: string): Connection {
  if (POSTGRES_URL.test(location)) return connectPostgres(ctx, location);
  if (OTHER_URL.test(location)) {
    throw new DocleusError(
      "storage/unsupported-location",
      `unsupported database location "${location.replace(/\/\/[^@/]*@/, "//")}": expected a postgres:// URL or a SQLite file path`,
    );
  }
  return connectSqlite(location);
}

/**
 * Default `storage` implementation over Kysely.
 *
 * `location` selects the database: omitted for an in-memory SQLite
 * database, a `postgres://` or `postgresql://` URL for Postgres (through a
 * `pg` connection pool), anything else as a SQLite file path. Other URL
 * schemes throw `storage/unsupported-location`.
 *
 * On Postgres, schema builder column types are made to behave like SQLite:
 * `integer` becomes `bigint` (millisecond timestamps overflow int4), `blob`
 * becomes `bytea`, and `text` columns use the `"C"` collation (byte order,
 * like SQLite's default). int8 values are returned as JS numbers. Every
 * {@link StorageService.transaction} and migration takes one advisory lock,
 * so transactions run one at a time across all connections and processes,
 * as they do on SQLite's single connection.
 *
 * @stability experimental
 */
export function createStorageService(
  ctx: Context,
  location?: string,
): StorageService {
  const { dialect, db } = connect(ctx, location ?? ":memory:");

  // Queued in-process before a connection is taken, so at most one pooled
  // connection per process waits on the advisory lock and the rest stay
  // free for queries the lock holder runs outside its transaction.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: (trx: Kysely<unknown>) => Promise<T>): Promise<T> {
    const run = queue.then(() =>
      db.transaction().execute(async (trx) => {
        if (dialect === "postgres") {
          await sql`select pg_advisory_xact_lock(${POSTGRES_LOCK_KEY})`.execute(
            trx,
          );
        }
        return fn(trx);
      }),
    );
    queue = run.catch(() => undefined);
    return run;
  }

  // Under the lock, so processes starting together on one Postgres
  // database do not race on creating it.
  const ready = serialized((trx) =>
    trx.schema
      .createTable(MIGRATIONS_TABLE)
      .ifNotExists()
      .addColumn("key", "text", (c) => c.primaryKey())
      .execute(),
  );
  // Every `migrate()` call still running, across all consumers, so disposal
  // can wait for them. A plugin that unloads without awaiting its own call
  // would otherwise race a running query against `db.destroy()`.
  // Every caller awaits `ready`, so its failure still surfaces there; this
  // only keeps an unobserved rejection from being reported as unhandled.
  ready.catch(() => undefined);
  const pending = new Set<Promise<unknown>>([ready]);
  ctx.effect(() => async () => {
    await Promise.allSettled(pending);
    await db.destroy();
  });

  return {
    dialect,
    db,
    migrate(owner, migrations) {
      // Added synchronously, before any `await`, so a `dispose()` that runs
      // right after this call still waits for it.
      const task = (async () => {
        await ready;
        for (const migration of migrations) {
          const key = `${owner}::${migration.id}`;
          // Checked inside the transaction: another process may have
          // applied it while this one waited for the lock.
          await serialized(async (trx) => {
            // Internal bookkeeping, not part of the untyped schema plugins see.
            const typed = trx as unknown as Kysely<MigrationsSchema>;
            const applied = await typed
              .selectFrom(MIGRATIONS_TABLE)
              .select("key")
              .where("key", "=", key)
              .executeTakeFirst();
            if (applied) return;
            await migration.up(trx);
            await typed.insertInto(MIGRATIONS_TABLE).values({ key }).execute();
          });
        }
      })();
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
    transaction(fn) {
      return serialized(fn);
    },
  };
}

/**
 * Creates the default `storage` service (see {@link createStorageService})
 * and provides it on `ctx`.
 *
 * @stability experimental
 */
export function provideStorage(ctx: Context, location?: string): () => void {
  return ctx.provide("storage", createStorageService(ctx, location));
}

export { DocleusError };
export type { Migration, StorageService };
