import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobsService } from "@docleus/core-blobs";
import { createJobsService } from "@docleus/core-jobs";
import { createStorageService } from "@docleus/core-storage";
import { Context, type Fiber } from "@docleus/kernel";
import { BLOB_PUT_REFRESH_MS, type BlobsService } from "@docleus/sdk";
import { testStorageLocation } from "@docleus/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLOB_GC_JOB,
  DEFAULT_BLOB_GC_GRACE_MS,
  collectBlobs,
  registerBlobCollector,
  type BlobCollectorOptions,
} from "./blob-gc.ts";

const DAY = 24 * 60 * 60 * 1000;
const fibers: Fiber[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const fiber of fibers.splice(0).toReversed()) await fiber.dispose();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-blob-gc-"));
  dirs.push(dir);
  return dir;
}

interface Harness {
  readonly root: Context;
  readonly blobsDir: string;
  put(text: string, ageMs?: number): Promise<string>;
  hashes(): Promise<string[]>;
}

async function boot(
  options: {
    readonly database?: string;
    readonly blobsDir?: string;
    readonly blobs?: (dir: string) => BlobsService;
  } = {},
): Promise<Harness> {
  const blobsDir = options.blobsDir ?? (await tempDir());
  const root = new Context();
  fibers.push(
    await root.plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, options.database));
      ctx.provide(
        "blobs",
        (options.blobs ?? ((dir) => createBlobsService(dir)))(blobsDir),
      );
    }),
  );
  fibers.push(
    await root.plugin({
      name: "jobs",
      inject: ["storage"],
      apply: (ctx: Context) => void ctx.provide("jobs", createJobsService(ctx)),
    }),
  );
  return {
    root,
    blobsDir,
    async put(text, ageMs = 0) {
      const { hash } = await root.blobs.put(new TextEncoder().encode(text));
      const at = new Date(Date.now() - ageMs);
      const path = join(blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);
      await utimes(path, at, at);
      return hash;
    },
    async hashes() {
      const found: string[] = [];
      for await (const entry of root.blobs.list?.() ?? []) {
        found.push(entry.hash);
      }
      return found.toSorted();
    },
  };
}

function marking(harness: Harness, hashes: Iterable<string>): void {
  const marked = [...hashes];
  harness.root.on("blobs/mark", async ({ mark }) => {
    for (const hash of marked) mark(hash);
  });
}

describe("collectBlobs", () => {
  it("deletes unmarked blobs past the grace period and keeps the rest", async () => {
    const harness = await boot();
    const kept = await harness.put("referenced", 3 * DAY);
    const orphan = await harness.put("orphan", 3 * DAY);
    const fresh = await harness.put("just uploaded", DAY / 2);
    marking(harness, [kept, "f".repeat(64)]);

    const result = await collectBlobs(harness.root);
    expect(result).toEqual({
      isSupported: true,
      marked: 2,
      kept: 2,
      deleted: 1,
      deletedBytes: "orphan".length,
    });
    expect(await harness.hashes()).toEqual([kept, fresh].toSorted());
    expect(await harness.root.blobs.get(orphan)).toBeUndefined();
  });

  it("keeps an old blob that was put again", async () => {
    const harness = await boot();
    const hash = await harness.put("re-uploaded", 3 * DAY);
    await harness.root.blobs.put(new TextEncoder().encode("re-uploaded"));

    await collectBlobs(harness.root);
    expect(await harness.hashes()).toEqual([hash]);
  });

  it("deletes nothing when a marking listener fails", async () => {
    const harness = await boot();
    const orphan = await harness.put("orphan", 3 * DAY);
    harness.root.on("blobs/mark", async () => {
      throw new Error("cannot read references");
    });

    await expect(collectBlobs(harness.root)).rejects.toThrow();
    expect(await harness.hashes()).toEqual([orphan]);
  });

  it("stops deleting once stopped", async () => {
    const harness = await boot();
    await harness.put("one", 3 * DAY);
    await harness.put("two", 3 * DAY);

    const result = await collectBlobs(harness.root, { isStopped: () => true });
    expect(result.deleted).toBe(0);
    expect(await harness.hashes()).toHaveLength(2);
  });

  it("skips a blobs provider that cannot list", async () => {
    const harness = await boot({
      blobs: (dir) => {
        const { list: _list, ...rest } = createBlobsService(dir);
        return rest;
      },
    });
    expect((await collectBlobs(harness.root)).isSupported).toBe(false);
  });

  it("refuses a grace period a re-put blob could fall outside of", async () => {
    const harness = await boot();
    await expect(
      collectBlobs(harness.root, { graceMs: BLOB_PUT_REFRESH_MS }),
    ).rejects.toMatchObject({ code: "blobs/invalid-gc-options" });
  });
});

async function sharedDatabase(): Promise<string> {
  return (await testStorageLocation()) ?? join(await tempDir(), "docleus.db");
}

async function collector(
  harness: Harness,
  options: BlobCollectorOptions,
): Promise<void> {
  fibers.push(
    await harness.root.plugin({
      name: "collector",
      inject: ["storage", "blobs", "jobs"],
      apply: (ctx: Context) => registerBlobCollector(ctx, options),
    }),
  );
  // Let the schedule settle.
  await harness.root.storage.transaction(async () => undefined);
  for (let i = 0; i < 20; i += 1) {
    if ((await harness.root.jobs.stats()).pending > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("registerBlobCollector", () => {
  it("keeps one scheduled run across processes sharing a database", async () => {
    const database = await sharedDatabase();
    // One at a time: two SQLite connections that migrate at once lock each other out.
    const a = await boot({ database });
    await collector(a, {});
    const b = await boot({ database, blobsDir: a.blobsDir });
    await collector(b, {});

    expect(await b.root.jobs.stats()).toMatchObject({ pending: 1 });
  });

  it("collects when due and schedules the next run", async () => {
    const harness = await boot({ database: await sharedDatabase() });
    const orphan = await harness.put("orphan", 3 * DAY);
    // The first run is due ten minutes after scheduling; start in the past.
    const shift = 11 * 60 * 1000;
    await collector(harness, {
      now: () => Date.now() - shift,
      intervalMs: DAY,
    });

    expect(await harness.root.jobs.runOnce()).toBe(1);
    await expect(harness.root.blobs.get(orphan)).resolves.toBeUndefined();
    expect(await harness.root.jobs.stats()).toMatchObject({
      pending: 1,
      done: 1,
    });
    // The next run is a day away.
    expect(await harness.root.jobs.runOnce()).toBe(0);
  });

  it("ends a duplicate of the chain without collecting", async () => {
    const harness = await boot({ database: await sharedDatabase() });
    const orphan = await harness.put("orphan", 3 * DAY);
    await collector(harness, { intervalMs: DAY });
    await harness.root.jobs.enqueue(BLOB_GC_JOB, { runAt: 1 });

    expect(await harness.root.jobs.runOnce()).toBe(1);
    expect(await harness.hashes()).toEqual([orphan]);
    expect(await harness.root.jobs.stats()).toMatchObject({
      pending: 1,
      done: 1,
    });
  });

  it("uses a grace period longer than the put refresh window by default", () => {
    expect(DEFAULT_BLOB_GC_GRACE_MS).toBeGreaterThan(BLOB_PUT_REFRESH_MS);
  });
});
