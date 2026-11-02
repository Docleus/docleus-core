import { DocleusError, type Context } from "@docleus/kernel";
import { BLOB_PUT_REFRESH_MS, z, type Migration } from "@docleus/sdk";
import type { Kysely } from "kysely";

const OWNER = "@docleus/server/blob-gc";
const KEY = "blobs";

/** The job type of a blob garbage collection run. */
export const BLOB_GC_JOB = "blobs/collect";

/** How often blob garbage collection runs when not configured: daily. */
export const DEFAULT_BLOB_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How old an unreferenced blob must be before it is deleted: one day. */
export const DEFAULT_BLOB_GC_GRACE_MS = 24 * 60 * 60 * 1000;
/** The delay of the first run after a fresh schedule, so a booting instance settles first. */
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

interface ScheduleTable {
  key: string;
  /** When the scheduled run is due, in ms since epoch. */
  run_at: number;
}

interface ScheduleSchema {
  blob_gc_schedule: ScheduleTable;
}

type Db = Kysely<ScheduleSchema>;

const migrations: readonly Migration[] = [
  {
    id: "0001-blob-gc-schedule",
    async up(db) {
      await (db as unknown as Db).schema
        .createTable("blob_gc_schedule")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("run_at", "integer", (c) => c.notNull())
        .execute();
    },
  },
];

const PayloadSchema = z.strictObject({ runAt: z.number().int() });

export interface BlobCollectionOptions {
  /** Unreferenced blobs stored more recently than this are kept. */
  readonly graceMs?: number;
  readonly now?: () => number;
  /** Checked before every delete; collection stops once it returns true. */
  readonly isStopped?: () => boolean;
}

export interface BlobCollection {
  /** False when the `blobs` provider cannot list its blobs. */
  readonly isSupported: boolean;
  readonly marked: number;
  readonly kept: number;
  readonly deleted: number;
  readonly deletedBytes: number;
}

function assertGrace(graceMs: number): void {
  // A `put` of bytes already stored may leave `storedAt` that old, so a
  // shorter grace period could delete a blob that was just put.
  if (!Number.isFinite(graceMs) || graceMs <= BLOB_PUT_REFRESH_MS) {
    throw new DocleusError(
      "blobs/invalid-gc-options",
      `graceMs must be more than ${BLOB_PUT_REFRESH_MS}, got ${graceMs}`,
    );
  }
}

/**
 * Mark and sweep over `ctx.blobs`: `blobs/mark` collects the hashes plugins
 * still reference, then every unmarked blob stored before the grace period
 * is deleted. Marking runs before listing, so a blob put again after the
 * marks were taken shows a fresh `storedAt` and is kept.
 */
export async function collectBlobs(
  ctx: Context,
  options: BlobCollectionOptions = {},
): Promise<BlobCollection> {
  const graceMs = options.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS;
  assertGrace(graceMs);
  const now = options.now ?? Date.now;
  const isStopped = options.isStopped ?? (() => false);
  const blobs = ctx.blobs;
  if (!blobs.list) {
    return {
      isSupported: false,
      marked: 0,
      kept: 0,
      deleted: 0,
      deletedBytes: 0,
    };
  }
  const marked = new Set<string>();
  await ctx.parallel("blobs/mark", {
    mark(hash) {
      marked.add(hash);
    },
  });
  const cutoff = now() - graceMs;
  let kept = 0;
  let deleted = 0;
  let deletedBytes = 0;
  for await (const entry of blobs.list()) {
    if (marked.has(entry.hash) || entry.storedAt >= cutoff) {
      kept += 1;
      continue;
    }
    if (isStopped()) break;
    if (await blobs.delete(entry.hash)) {
      deleted += 1;
      deletedBytes += entry.size;
    }
  }
  return {
    isSupported: true,
    marked: marked.size,
    kept,
    deleted,
    deletedBytes,
  };
}

export interface BlobCollectorOptions {
  readonly intervalMs?: number;
  readonly graceMs?: number;
  readonly now?: () => number;
}

/**
 * Runs {@link collectBlobs} every `intervalMs` as a `jobs` chain: each run
 * enqueues the next. `blob_gc_schedule` holds the due time of the chain,
 * so processes sharing a database keep one chain between them. Register it
 * only in processes that run jobs, in a fiber that also injects every core
 * key that marks blobs, so that it stops when one of them goes away.
 */
export function registerBlobCollector(
  ctx: Context,
  options: BlobCollectorOptions = {},
): void {
  const intervalMs = options.intervalMs ?? DEFAULT_BLOB_GC_INTERVAL_MS;
  const graceMs = options.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS;
  assertGrace(graceMs);
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new DocleusError(
      "blobs/invalid-gc-options",
      `intervalMs must be a positive integer, got ${intervalMs}`,
    );
  }
  const now = options.now ?? Date.now;
  const logger = ctx.logger("blobs");
  const storage = ctx.storage;
  const ready = storage.migrate(OWNER, migrations);
  const db = storage.db as unknown as Db;
  let isStopped = false;

  async function scheduledAt(): Promise<number | undefined> {
    const row = await db
      .selectFrom("blob_gc_schedule")
      .select("run_at")
      .where("key", "=", KEY)
      .executeTakeFirst();
    return row?.run_at;
  }

  /** Moves the schedule from `from` to `to`; false when another process moved it first. */
  async function advance(from: number | undefined, to: number) {
    if (from === undefined) {
      await db
        .insertInto("blob_gc_schedule")
        .values({ key: KEY, run_at: to })
        .onConflict((oc) => oc.column("key").doNothing())
        .execute();
    } else {
      await db
        .updateTable("blob_gc_schedule")
        .set({ run_at: to })
        .where("key", "=", KEY)
        .where("run_at", "=", from)
        .execute();
    }
    // Read back rather than counting affected rows, which the SQLite
    // adapter does not report.
    return (await scheduledAt()) === to;
  }

  async function enqueue(runAt: number): Promise<void> {
    await ctx.jobs.enqueue(BLOB_GC_JOB, { runAt }, { runAt, maxAttempts: 1 });
  }

  async function ensureScheduled(): Promise<void> {
    await ready;
    const current = await scheduledAt();
    // A due time less than an interval in the past still has its job queued.
    if (current !== undefined && current > now() - intervalMs) return;
    const runAt = now() + FIRST_RUN_DELAY_MS;
    if (await advance(current, runAt)) await enqueue(runAt);
  }

  ctx.jobs.handle(BLOB_GC_JOB, async (job) => {
    const payload = PayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new DocleusError(
        "blobs/invalid-gc-job",
        `job ${job.id} has an invalid payload`,
      );
    }
    await ready;
    const next = now() + intervalMs;
    // A duplicate of the chain loses here and ends.
    if (!(await advance(payload.data.runAt, next))) return;
    await enqueue(next);
    const result = await collectBlobs(ctx, {
      graceMs,
      now,
      isStopped: () => isStopped,
    });
    if (!result.isSupported) {
      logger.info("the blobs provider cannot list blobs; skipping collection");
      return;
    }
    logger.info(
      "collected %d unreferenced blobs (%d bytes); kept %d",
      result.deleted,
      result.deletedBytes,
      result.kept,
    );
  });

  ctx.effect(() => {
    const scheduling = ensureScheduled().catch((error: unknown) => {
      logger.warn("scheduling blob collection failed: %s", error);
    });
    return async () => {
      isStopped = true;
      await scheduling;
    };
  }, "blob collector");
}
