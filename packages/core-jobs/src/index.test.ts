import { Context, type Fiber } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import {
  jobsConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import type { Job, JobsService } from "@docleus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobsService, type JobsOptions } from "./index.ts";

const fibers: Fiber[] = [];

async function freshJobs(
  options?: JobsOptions,
): Promise<{ jobs: JobsService; ctx: Context; fiber: Fiber }> {
  let jobs!: JobsService;
  let owner!: Context;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    jobs = createJobsService(ctx, options);
    owner = ctx;
  });
  fibers.push(fiber);
  return { jobs, ctx: owner, fiber };
}

runConformanceSuite(jobsConformanceSuite, async () => (await freshJobs()).jobs);

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createJobsService", () => {
  it("never runs more jobs at once than the concurrency limit", async () => {
    const { jobs } = await freshJobs({ concurrency: 2 });
    const gate = deferred();
    let running = 0;
    let peak = 0;
    jobs.handle("test/job", async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    });
    for (let i = 0; i < 5; i++) await jobs.enqueue("test/job", { i });

    const first = jobs.runOnce();
    const second = jobs.runOnce();
    await vi.waitFor(() => expect(running).toBe(2));
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([2, 0]);
    expect(peak).toBe(2);
  });

  it("backs off exponentially between attempts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { jobs } = await freshJobs({ retryBaseDelayMs: 100 });
    jobs.handle("test/broken", async () => {
      throw new Error("fails");
    });
    await jobs.enqueue("test/broken", {}, { maxAttempts: 4 });
    const start = Date.now();

    async function runAt(offset: number): Promise<number> {
      vi.setSystemTime(start + offset);
      return jobs.runOnce();
    }

    expect(await runAt(0)).toBe(1);
    expect(await runAt(99)).toBe(0);
    expect(await runAt(100)).toBe(1);
    expect(await runAt(100 + 199)).toBe(0);
    expect(await runAt(100 + 200)).toBe(1);
    expect(await runAt(300 + 399)).toBe(0);
    expect(await runAt(300 + 400)).toBe(1);
  });

  it("emits jobs/dead with the job and its last error", async () => {
    const { jobs, ctx } = await freshJobs();
    const dead: [Job, unknown][] = [];
    ctx.on("jobs/dead", (job, error) => {
      dead.push([job, error]);
    });
    const failure = new Error("always fails");
    jobs.handle("test/broken", async () => {
      throw failure;
    });
    const id = await jobs.enqueue("test/broken", { x: 1 }, { maxAttempts: 1 });
    await jobs.runOnce();
    expect(dead).toEqual([
      [{ id, type: "test/broken", payload: { x: 1 }, attempt: 1 }, failure],
    ]);
  });

  it("counts running jobs in stats", async () => {
    const { jobs } = await freshJobs();
    const gate = deferred();
    let isStarted = false;
    jobs.handle("test/job", async () => {
      isStarted = true;
      await gate.promise;
    });
    await jobs.enqueue("test/job", {});
    const run = jobs.runOnce();
    await vi.waitFor(() => expect(isStarted).toBe(true));
    expect((await jobs.stats()).running).toBe(1);
    gate.resolve();
    await run;
  });

  it("lets running jobs finish before the storage connection closes", async () => {
    // Cordis disposes the effects of one fiber concurrently, but a provider
    // waits for its dependents to unload first; the jobs service therefore
    // lives in its own plugin that injects `storage`, as it does in a real
    // deployment.
    const root = new Context();
    const storageLocation = await testStorageLocation();
    const storageFiber = await root.plugin((ctx: Context) =>
      ctx.provide("storage", createStorageService(ctx, storageLocation)),
    );
    let jobs!: JobsService;
    await root.plugin({
      inject: ["storage"],
      apply: (ctx: Context) => {
        jobs = createJobsService(ctx);
      },
    });
    const gate = deferred();
    let isStarted = false;
    jobs.handle("test/job", async () => {
      isStarted = true;
      await gate.promise;
    });
    await jobs.enqueue("test/job", {});
    const run = jobs.runOnce();
    await vi.waitFor(() => expect(isStarted).toBe(true));
    const disposed = storageFiber.dispose();
    // Let teardown run as far as it can before the job finishes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resolve();
    await expect(run).resolves.toBe(1);
    await disposed;
  });

  it("removes handlers when the owning plugin unloads", async () => {
    const root = new Context();
    const storageLocation = await testStorageLocation();
    const storageFiber = await root.plugin((ctx: Context) =>
      ctx.provide("storage", createStorageService(ctx, storageLocation)),
    );
    let jobs!: JobsService;
    const ownerFiber = await root.plugin({
      inject: ["storage"],
      apply: (ctx: Context) => {
        jobs = createJobsService(ctx);
        jobs.handle("test/job", async () => {});
      },
    });
    expect(() => jobs.handle("test/job", async () => {})).toThrow();
    await ownerFiber.dispose();
    await storageFiber.dispose();
  });

  it("rejects invalid enqueue options and payloads with stable codes", async () => {
    const { jobs } = await freshJobs();
    await expect(
      jobs.enqueue("test/job", {}, { maxAttempts: 0 }),
    ).rejects.toMatchObject({ code: "jobs/invalid-options" });
    await expect(jobs.enqueue("test/job", undefined)).rejects.toMatchObject({
      code: "jobs/invalid-payload",
    });
  });
});
