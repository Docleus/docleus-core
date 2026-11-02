import { Context, type Fiber } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import type { Job, JobsService } from "@docleus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobsService, type JobsOptions } from "./index.ts";

const fibers: Fiber[] = [];
const gates: (() => void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const open of gates.splice(0)) open();
  for (const fiber of fibers.splice(0).toReversed()) await fiber.dispose();
});

/**
 * Two job services on one database, as two worker processes would have.
 * A service whose handler never returns stands for a worker that died
 * while running the job.
 */
async function twoWorkers(options: JobsOptions): Promise<{
  first: JobsService;
  second: JobsService;
  ctx: Context;
}> {
  let first!: JobsService;
  let second!: JobsService;
  let owner!: Context;
  const location = await testStorageLocation();
  const root = new Context();
  // The jobs services live in a plugin that injects `storage`, so storage
  // closes only after they drained, as in a real deployment.
  fibers.push(
    await root.plugin((ctx: Context) =>
      ctx.provide("storage", createStorageService(ctx, location)),
    ),
  );
  fibers.push(
    await root.plugin({
      inject: ["storage"],
      apply(ctx: Context) {
        first = createJobsService(ctx, options);
        second = createJobsService(ctx, options);
        owner = ctx;
      },
    }),
  );
  return { first, second, ctx: owner };
}

/** A handler that hangs until the test ends. */
function hang(started: Job[]): (job: Job) => Promise<void> {
  return (job) => {
    started.push(job);
    return new Promise<void>((resolve) => gates.push(resolve));
  };
}

describe("job leases", () => {
  it("re-queues a running job whose lease expired as its next attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { first, second } = await twoWorkers({
      leaseMs: 60_000,
      retryBaseDelayMs: 100,
    });
    const crashed: Job[] = [];
    first.handle("test/job", hang(crashed));
    const seen: Job[] = [];
    second.handle("test/job", async (job) => {
      seen.push(job);
    });
    const id = await first.enqueue("test/job", { n: 1 });

    void first.runOnce();
    await vi.waitFor(() => expect(crashed).toHaveLength(1));
    // `vi.waitFor` advances the faked clock, so read it after the claim.
    const start = Date.now();
    expect(await second.runOnce()).toBe(0);

    vi.setSystemTime(start + 60_000);
    expect(await second.runOnce()).toBe(0);
    expect(await second.stats()).toMatchObject({ running: 0, pending: 1 });

    vi.setSystemTime(start + 60_000 + 100);
    expect(await second.runOnce()).toBe(1);
    expect(seen).toEqual([
      { id, type: "test/job", payload: { n: 1 }, attempt: 2 },
    ]);
    expect(await second.stats()).toMatchObject({ running: 0, done: 1 });
  });

  it("marks a job dead when its lease expires on the last attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { first, second, ctx } = await twoWorkers({ leaseMs: 1000 });
    const dead: [Job, unknown][] = [];
    ctx.on("jobs/dead", (job, error) => {
      dead.push([job, error]);
    });
    const crashed: Job[] = [];
    first.handle("test/job", hang(crashed));
    second.handle("test/job", async () => {});
    const id = await first.enqueue("test/job", {}, { maxAttempts: 1 });

    void first.runOnce();
    await vi.waitFor(() => expect(crashed).toHaveLength(1));
    vi.setSystemTime(Date.now() + 1000);
    expect(await second.runOnce()).toBe(0);
    expect(await second.stats()).toMatchObject({ running: 0, dead: 1 });
    expect(dead).toEqual([
      [
        { id, type: "test/job", payload: {}, attempt: 1 },
        expect.objectContaining({ code: "jobs/lease-expired" }),
      ],
    ]);
  });

  it("does not let an attempt that lost its lease overwrite the next one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { first, second } = await twoWorkers({
      leaseMs: 1000,
      retryBaseDelayMs: 0,
    });
    let release!: () => void;
    let isStarted = false;
    first.handle("test/job", async () => {
      isStarted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
        gates.push(resolve);
      });
      throw new Error("late failure");
    });
    const gate: Job[] = [];
    second.handle("test/job", hang(gate));
    await first.enqueue("test/job", {}, { maxAttempts: 2 });

    const late = first.runOnce();
    await vi.waitFor(() => expect(isStarted).toBe(true));
    vi.setSystemTime(Date.now() + 1000);
    void second.runOnce();
    await vi.waitFor(() => expect(gate).toHaveLength(1));

    release();
    await late;
    expect(await second.stats()).toMatchObject({ running: 1, pending: 0 });
  });

  it("keeps the lease of a job that is still running", async () => {
    const { first, second } = await twoWorkers({ leaseMs: 300 });
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    };
    first.handle("test/job", work);
    second.handle("test/job", work);
    await first.enqueue("test/job", {});

    const running = first.runOnce();
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      expect(await second.runOnce()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await running;
    expect(runs).toBe(1);
    expect(await first.stats()).toMatchObject({ running: 0, done: 1 });
  });

  it("refuses a lease that is not a positive integer", async () => {
    const { ctx } = await twoWorkers({});
    for (const leaseMs of [0, 1.5, -1]) {
      expect(() => createJobsService(ctx, { leaseMs })).toThrow(
        expect.objectContaining({ code: "jobs/invalid-options" }),
      );
    }
  });
});
