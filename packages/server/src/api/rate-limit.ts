import type { StorageService } from "@docleus/sdk";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";

const OWNER = "@docleus/server/api";

interface FailuresTable {
  id: string;
  key: string;
  at: number;
}

interface RateLimitSchema {
  auth_failures: FailuresTable;
}

type Db = Kysely<RateLimitSchema>;

const rateLimitMigrations = [
  {
    id: "0001-auth-failures",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Db;
      await typed.schema
        .createTable("auth_failures")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("key", "text", (c) => c.notNull())
        .addColumn("at", "integer", (c) => c.notNull())
        .execute();
      await typed.schema
        .createIndex("auth_failures_key_at")
        .on("auth_failures")
        .columns(["key", "at"])
        .execute();
      await typed.schema
        .createIndex("auth_failures_at")
        .on("auth_failures")
        .column("at")
        .execute();
    },
  },
];

export interface FailureLimit {
  readonly key: string;
  readonly max: number;
}

export type FailureAdmission =
  | { readonly isAllowed: true; readonly failureIds: readonly string[] }
  | { readonly isAllowed: false; readonly retryAfterSeconds: number };

export interface FailureLimiter {
  /**
   * Refuses when any key already has `max` failures in the window, with the
   * seconds until it may try again. Otherwise counts one failure for every
   * key up front, so concurrent attempts cannot outrun the limit; take them
   * back with `forgive` or `clear` when the attempt succeeds.
   */
  admit(limits: readonly FailureLimit[]): Promise<FailureAdmission>;
  /** Takes back the failures with these ids. */
  forgive(failureIds: readonly string[]): Promise<void>;
  /** Forgets every failure of `key`. */
  clear(key: string): Promise<void>;
}

/**
 * Counts failures per key over a sliding window in `storage`, so that every
 * process on the database shares the count. Expired failures are deleted
 * on every admission, so the table only holds the failures of one window.
 */
export function createFailureLimiter(
  storage: StorageService,
  windowMs: number,
  now: () => number,
): FailureLimiter {
  const db = storage.db as unknown as Db;
  const ready = storage.migrate(OWNER, rateLimitMigrations);

  return {
    async admit(limits) {
      await ready;
      return storage.transaction(async (raw) => {
        const trx = raw as unknown as Db;
        const at = now();
        const since = at - windowMs;
        await trx
          .deleteFrom("auth_failures")
          .where("at", "<=", since)
          .execute();
        let retryAfterMs = 0;
        for (const limit of limits) {
          // The `max`-th most recent failure: once it leaves the window the
          // key is below the limit again.
          const row = await trx
            .selectFrom("auth_failures")
            .select("at")
            .where("key", "=", limit.key)
            .where("at", ">", since)
            .orderBy("at", "desc")
            .orderBy("id", "desc")
            .limit(1)
            .offset(limit.max - 1)
            .executeTakeFirst();
          if (row) {
            retryAfterMs = Math.max(retryAfterMs, row.at + windowMs - at);
          }
        }
        if (retryAfterMs > 0) {
          return {
            isAllowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          };
        }
        const rows = limits.map((limit) => ({
          id: randomUUID(),
          key: limit.key,
          at,
        }));
        if (rows.length > 0) {
          await trx.insertInto("auth_failures").values(rows).execute();
        }
        return { isAllowed: true, failureIds: rows.map((row) => row.id) };
      });
    },
    async forgive(failureIds) {
      if (failureIds.length === 0) return;
      await ready;
      await db
        .deleteFrom("auth_failures")
        .where("id", "in", failureIds)
        .execute();
    },
    async clear(key) {
      await ready;
      await db.deleteFrom("auth_failures").where("key", "=", key).execute();
    },
  };
}
