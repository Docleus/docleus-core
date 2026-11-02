import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DocleusError, type Context } from "@docleus/kernel";
import type { Migration, StorageService } from "@docleus/sdk";
import type { Kysely } from "kysely";

const OWNER = "@docleus/server/install-lock";
const KEY = "plugins";

interface InstallLockTable {
  key: string;
  holder: string;
  expires_at: number;
}

interface InstallLockSchema {
  plugin_install_lock: InstallLockTable;
}

type Db = Kysely<InstallLockSchema>;

const migrations: readonly Migration[] = [
  {
    id: "0001-plugin-install-lock",
    async up(db) {
      await (db as unknown as Db).schema
        .createTable("plugin_install_lock")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("holder", "text", (c) => c.notNull())
        .addColumn("expires_at", "integer", (c) => c.notNull())
        .execute();
    },
  },
];

// Read back rather than counting affected rows, which the SQLite
// adapter does not report.
async function holderOf(db: Db): Promise<string | undefined> {
  const row = await db
    .selectFrom("plugin_install_lock")
    .select("holder")
    .where("key", "=", KEY)
    .executeTakeFirst();
  return row?.holder;
}

export interface InstallLockOptions {
  /** How long a lease lasts without renewal, so a crashed holder frees it. */
  readonly leaseMs?: number;
  /** How often the holder renews its lease. */
  readonly renewMs?: number;
  /** How long to wait for another holder before `plugin/install-busy`. */
  readonly waitMs?: number;
  /** How often a waiter tries again. */
  readonly pollMs?: number;
}

export interface InstallLock {
  /** Runs `task` while holding the lease, waiting for any other holder first. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_WAIT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 250;

/**
 * A lease in `ctx.storage` that every process on the database shares, so
 * plugin installs run one at a time across web processes. A lease row
 * rather than a held transaction: an install takes minutes, and a
 * transaction would hold up every other write for as long.
 */
export function createInstallLock(
  ctx: Context,
  options: InstallLockOptions = {},
): InstallLock {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const renewMs = options.renewMs ?? Math.floor(leaseMs / 3);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const logger = ctx.logger("plugins");
  // Per storage service: a plugin may replace `storage` while this lives.
  const ready = new WeakMap<StorageService, Promise<void>>();

  async function database(): Promise<Db> {
    const storage = ctx.storage;
    let migrated = ready.get(storage);
    if (!migrated) {
      migrated = storage.migrate(OWNER, migrations);
      ready.set(storage, migrated);
    }
    await migrated;
    return storage.db as unknown as Db;
  }

  async function tryAcquire(holder: string): Promise<boolean> {
    const db = await database();
    const now = Date.now();
    await db
      .insertInto("plugin_install_lock")
      .values({ key: KEY, holder, expires_at: now + leaseMs })
      .onConflict((oc) =>
        oc
          .column("key")
          .doUpdateSet({ holder, expires_at: now + leaseMs })
          .where("plugin_install_lock.expires_at", "<=", now),
      )
      .execute();
    return (await holderOf(db)) === holder;
  }

  async function renew(holder: string): Promise<void> {
    const db = await database();
    await db
      .updateTable("plugin_install_lock")
      .set({ expires_at: Date.now() + leaseMs })
      .where("key", "=", KEY)
      .where("holder", "=", holder)
      .execute();
    if ((await holderOf(db)) !== holder) {
      logger.warn("lost the plugin install lease");
    }
  }

  async function release(holder: string): Promise<void> {
    const db = await database();
    await db
      .deleteFrom("plugin_install_lock")
      .where("key", "=", KEY)
      .where("holder", "=", holder)
      .execute();
  }

  return {
    async run(task) {
      const holder = randomUUID();
      const deadline = Date.now() + waitMs;
      while (!(await tryAcquire(holder))) {
        if (Date.now() >= deadline) {
          throw new DocleusError(
            "plugin/install-busy",
            "another process is installing a plugin; try again later",
          );
        }
        await sleep(pollMs);
      }
      const stopRenewing = ctx.effect(() => {
        const timer = setInterval(() => {
          renew(holder).catch((error: unknown) => {
            logger.warn("cannot renew the plugin install lease: %s", error);
          });
        }, renewMs);
        return () => clearInterval(timer);
      }, "plugin install lease");
      try {
        return await task();
      } finally {
        await stopRenewing();
        await release(holder);
      }
    },
  };
}
