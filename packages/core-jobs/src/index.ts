import { DocleusError, type Context } from "@docleus/kernel";
import {
  trackCaller,
  type Job,
  type JobStats,
  type JobsService,
} from "@docleus/sdk";
import type { Kysely, UpdateQueryBuilder, UpdateResult } from "kysely";
import { v7 as uuidv7 } from "uuid";
import { jobsMigrations, type JobsSchema, type JobsTable } from "./schema.ts";

export interface JobsOptions {
  /** Jobs running at once across all `runOnce` calls. Defaults to 4. */
  concurrency?: number;
  /** Delay before the first retry; each later retry doubles it. Defaults to 1000 ms. */
  retryBaseDelayMs?: number;
  /**
   * How long a claimed attempt stays leased to its worker. The worker renews
   * the lease every third of it while the handler runs; an attempt whose
   * lease ran out (its process died) counts as failed and is retried or
   * marked dead. Defaults to 60000 ms.
   */
  leaseMs?: number;
}

/** The lease of a claimed attempt when {@link JobsOptions.leaseMs} is omitted. */
export const DEFAULT_JOB_LEASE_MS = 60_000;

type Handler = (job: Job) => Promise<void>;

/** Limits an update to the attempt `row` claimed, while it still holds its lease. */
function ownAttempt<
  T extends UpdateQueryBuilder<JobsSchema, "jobs", "jobs", UpdateResult>,
>(query: T, row: JobsTable): T {
  return query
    .where("id", "=", row.id)
    .where("attempt", "=", row.attempt)
    .where("status", "=", "running") as T;
}

function jobOf(row: JobsTable): Job {
  return {
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    attempt: row.attempt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Default `jobs` implementation: a queue in the `jobs` table of
 * `ctx.storage`. Disposing the owning plugin waits for jobs that are
 * already running before the storage connection closes.
 *
 * @stability experimental
 */
export function createJobsService(
  ctx: Context,
  options: JobsOptions = {},
): JobsService {
  const concurrency = options.concurrency ?? 4;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new DocleusError(
      "jobs/invalid-options",
      `leaseMs must be a positive integer, got ${leaseMs}`,
    );
  }
  const logger = ctx.logger("jobs");
  const db = ctx.storage.db as unknown as Kysely<JobsSchema>;
  const ready = ctx.storage.migrate("@docleus/core-jobs", jobsMigrations);
  const handlers = new Map<string, Handler>();
  const inFlight = new Set<Promise<void>>();
  // Reserved synchronously in runOnce so that concurrent calls cannot
  // together claim more than `concurrency` jobs.
  let reserved = 0;

  ctx.effect(
    () => async () => {
      await Promise.allSettled(inFlight);
    },
    "ctx.jobs drain",
  );

  function retryAt(row: JobsTable, now: number): number {
    return now + retryBaseDelayMs * 2 ** (row.attempt - 1);
  }

  /** Ends attempts whose lease ran out; returns the jobs that died. */
  async function recover(
    typed: Kysely<JobsSchema>,
    now: number,
  ): Promise<JobsTable[]> {
    const expired = await typed
      .selectFrom("jobs")
      .selectAll()
      .where("status", "=", "running")
      .where("lease_until", "<=", now)
      .execute();
    const dead: JobsTable[] = [];
    for (const row of expired) {
      const isDead = row.attempt >= row.max_attempts;
      await typed
        .updateTable("jobs")
        .set({
          status: isDead ? "dead" : "pending",
          run_at: isDead ? row.run_at : retryAt(row, now),
          lease_until: null,
          last_error: `attempt ${row.attempt} lost its lease; its worker stopped`,
        })
        .where("id", "=", row.id)
        .execute();
      if (isDead) dead.push(row);
    }
    return dead;
  }

  async function claim(limit: number): Promise<JobsTable[]> {
    const types = [...handlers.keys()];
    const { due, dead } = await ctx.storage.transaction(async (trx) => {
      const typed = trx as unknown as Kysely<JobsSchema>;
      const now = Date.now();
      const lost = await recover(typed, now);
      if (types.length === 0) return { due: [], dead: lost };
      const rows = await typed
        .selectFrom("jobs")
        .selectAll()
        .where("status", "=", "pending")
        .where("run_at", "<=", now)
        .where("type", "in", types)
        .orderBy("run_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      for (const row of rows) {
        await typed
          .updateTable("jobs")
          .set({
            status: "running",
            attempt: row.attempt + 1,
            lease_until: now + leaseMs,
          })
          .where("id", "=", row.id)
          .execute();
      }
      return {
        due: rows.map((row) => ({
          ...row,
          attempt: row.attempt + 1,
          lease_until: now + leaseMs,
        })),
        dead: lost,
      };
    });
    for (const row of dead) {
      ctx.emit(
        "jobs/dead",
        jobOf(row),
        new DocleusError(
          "jobs/lease-expired",
          `attempt ${row.attempt} of job "${row.id}" lost its lease`,
        ),
      );
    }
    return due;
  }

  /** Renews the lease of a running attempt until the returned function stops it. */
  function keepLease(row: JobsTable): () => Promise<void> {
    let renewal: Promise<void> = Promise.resolve();
    const timer = setInterval(
      () => {
        renewal = renewal.then(async () => {
          try {
            await ownAttempt(
              db.updateTable("jobs").set({ lease_until: Date.now() + leaseMs }),
              row,
            ).execute();
          } catch (error) {
            logger.warn(
              "renewing the lease of job %s failed: %s",
              row.id,
              error,
            );
          }
        });
      },
      Math.max(1, Math.floor(leaseMs / 3)),
    );
    return async () => {
      clearInterval(timer);
      await renewal;
    };
  }

  async function settle(row: JobsTable, handler: Handler): Promise<void> {
    const job = jobOf(row);
    const stopLease = keepLease(row);
    let failure: { error: unknown } | undefined;
    try {
      await handler(job);
    } catch (error) {
      failure = { error };
    } finally {
      await stopLease();
    }
    const isDead = failure !== undefined && row.attempt >= row.max_attempts;
    const updated = await ownAttempt(
      db.updateTable("jobs").set(
        failure === undefined
          ? { status: "done", lease_until: null, last_error: null }
          : {
              status: isDead ? "dead" : "pending",
              run_at: isDead ? row.run_at : retryAt(row, Date.now()),
              lease_until: null,
              last_error: errorMessage(failure.error),
            },
      ),
      row,
    )
      .returning("id")
      .execute();
    if (updated.length === 0) {
      logger.warn(
        "attempt %d of job %s finished after it lost its lease; its result is dropped",
        row.attempt,
        row.id,
      );
      return;
    }
    if (isDead) ctx.emit("jobs/dead", job, failure?.error);
  }

  return trackCaller<JobsService>(ctx, {
    handle(type, handler) {
      return this.ctx.effect(
        () => {
          if (handlers.has(type)) {
            throw new DocleusError(
              "jobs/handler-already-registered",
              `a handler for "${type}" is already registered`,
            );
          }
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
        `ctx.jobs.handle(${JSON.stringify(type)})`,
      );
    },
    async enqueue(type, payload, { runAt, maxAttempts = 3 } = {}) {
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new DocleusError(
          "jobs/invalid-options",
          `maxAttempts must be a positive integer, got ${maxAttempts}`,
        );
      }
      const serialized = JSON.stringify(payload) as string | undefined;
      if (serialized === undefined) {
        throw new DocleusError(
          "jobs/invalid-payload",
          `payload of "${type}" is not JSON-serializable`,
        );
      }
      await ready;
      const id = uuidv7();
      await db
        .insertInto("jobs")
        .values({
          id,
          type,
          payload: serialized,
          status: "pending",
          attempt: 0,
          max_attempts: maxAttempts,
          run_at: runAt ?? Date.now(),
          last_error: null,
          lease_until: null,
        })
        .execute();
      return id;
    },
    async runOnce() {
      const limit = concurrency - reserved;
      if (limit <= 0) return 0;
      reserved += limit;
      let rows: JobsTable[];
      try {
        await ready;
        rows = await claim(limit);
      } finally {
        reserved -= limit;
      }
      reserved += rows.length;
      const runs = rows.map((row) => {
        // The handler may have been removed while the claim was in
        // flight; the attempt then fails and is retried like any other.
        const handler = handlers.get(row.type);
        const run = (
          handler
            ? settle(row, handler)
            : settle(row, async () => {
                throw new DocleusError(
                  "jobs/no-handler",
                  `no handler for "${row.type}"`,
                );
              })
        ).finally(() => {
          reserved -= 1;
          inFlight.delete(run);
        });
        inFlight.add(run);
        return run;
      });
      await Promise.all(runs);
      return rows.length;
    },
    async stats() {
      await ready;
      const rows = await db
        .selectFrom("jobs")
        .select((eb) => ["status", eb.fn.countAll<number>().as("count")])
        .groupBy("status")
        .execute();
      const stats: JobStats = { pending: 0, running: 0, done: 0, dead: 0 };
      for (const row of rows) stats[row.status] = Number(row.count);
      return stats;
    },
  });
}

export function provideJobs(ctx: Context, options?: JobsOptions): () => void {
  return ctx.provide("jobs", createJobsService(ctx, options));
}
