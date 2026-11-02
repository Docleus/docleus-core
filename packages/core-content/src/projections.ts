import { DocleusError, type Context } from "@docleus/kernel";
import type { LogEntry, Projection } from "@docleus/sdk";

const REPLAY_BATCH = 100;

export interface ProjectionStore {
  readCursor(name: string): Promise<number>;
  writeCursor(name: string, seq: number): Promise<void>;
  readLog(afterSeq: number, limit: number): Promise<LogEntry[]>;
}

export interface ProjectionRunner {
  /** Adds the projection and starts replaying; the returned function removes it. */
  add(projection: Projection): () => void;
  catchUp(name: string): Promise<void>;
  rebuild(name: string): Promise<void>;
  /** Schedules every projection to apply newly appended entries. */
  notify(): void;
}

interface Registered {
  readonly projection: Projection;
  /** The latest scheduled run; runs of one projection never overlap. */
  tail: Promise<void>;
  /** A run scheduled but not started, shared by every caller until it starts. */
  queued: Promise<void> | undefined;
}

/**
 * Applies the content log to projections, one run at a time per
 * projection. The cursor advances after each applied entry, so a failed
 * apply is retried from that entry by the next run.
 */
export function createProjectionRunner(
  ctx: Context,
  store: ProjectionStore,
): ProjectionRunner {
  const projections = new Map<string, Registered>();
  const logger = ctx.logger("content");

  function get(name: string): Registered {
    const registered = projections.get(name);
    if (!registered) {
      throw new DocleusError(
        "content/projection-not-found",
        `no projection named "${name}"`,
      );
    }
    return registered;
  }

  async function replay(registered: Registered): Promise<void> {
    const { name } = registered.projection;
    let cursor = await store.readCursor(name);
    for (;;) {
      const batch = await store.readLog(cursor, REPLAY_BATCH);
      if (batch.length === 0) return;
      for (const entry of batch) {
        if (projections.get(name) !== registered) return;
        await registered.projection.apply(entry);
        cursor = entry.seq;
        await store.writeCursor(name, cursor);
      }
    }
  }

  function enqueue(
    registered: Registered,
    task: () => Promise<void>,
  ): Promise<void> {
    // A failed run is reported to whoever awaited it; the next run still starts.
    const run = registered.tail.catch(() => undefined).then(task);
    registered.tail = run;
    return run;
  }

  function scheduleReplay(registered: Registered): Promise<void> {
    if (registered.queued) return registered.queued;
    const run = enqueue(registered, () => {
      registered.queued = undefined;
      return replay(registered);
    });
    registered.queued = run;
    return run;
  }

  function replayInBackground(registered: Registered): void {
    scheduleReplay(registered).catch((error: unknown) => {
      logger.warn(
        "projection %s failed to apply the log: %s",
        registered.projection.name,
        error,
      );
    });
  }

  return {
    add(projection) {
      if (projections.has(projection.name)) {
        throw new DocleusError(
          "content/projection-taken",
          `a projection named "${projection.name}" is already registered`,
        );
      }
      const registered: Registered = {
        projection,
        tail: Promise.resolve(),
        queued: undefined,
      };
      projections.set(projection.name, registered);
      replayInBackground(registered);
      return () => {
        if (projections.get(projection.name) === registered)
          projections.delete(projection.name);
      };
    },
    async catchUp(name) {
      return scheduleReplay(get(name));
    },
    async rebuild(name) {
      const registered = get(name);
      return enqueue(registered, async () => {
        await registered.projection.reset();
        await store.writeCursor(name, 0);
        await replay(registered);
      });
    },
    notify() {
      for (const registered of projections.values())
        replayInBackground(registered);
    },
  };
}
