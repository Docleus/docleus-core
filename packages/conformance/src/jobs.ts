import type { Job, JobsService } from "@docleus/sdk";
import { expect, vi } from "vitest";
import { defineConformanceSuite } from "./suite.ts";

const HOUR = 60 * 60 * 1000;

/** Runs `fn` with only `Date` faked, so retry delays can be skipped without touching I/O timers. */
async function withFakeDate(fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

export const jobsConformanceSuite = defineConformanceSuite<JobsService>(
  "jobs",
  [
    {
      name: "a due job runs once with its payload as attempt 1",
      async check(jobs) {
        const seen: Job[] = [];
        jobs.handle("test/job", async (job) => {
          seen.push(job);
        });
        const id = await jobs.enqueue("test/job", { n: 1 });
        expect(await jobs.runOnce()).toBe(1);
        expect(await jobs.runOnce()).toBe(0);
        expect(seen).toEqual([
          { id, type: "test/job", payload: { n: 1 }, attempt: 1 },
        ]);
        expect(await jobs.stats()).toEqual({
          pending: 0,
          running: 0,
          done: 1,
          dead: 0,
        });
      },
    },
    {
      name: "a job without a handler stays pending",
      async check(jobs) {
        await jobs.enqueue("test/unhandled", {});
        expect(await jobs.runOnce()).toBe(0);
        expect((await jobs.stats()).pending).toBe(1);
      },
    },
    {
      name: "a job scheduled in the future does not run until it is due",
      async check(jobs) {
        await withFakeDate(async () => {
          let runs = 0;
          jobs.handle("test/job", async () => {
            runs += 1;
          });
          await jobs.enqueue("test/job", {}, { runAt: Date.now() + HOUR });
          expect(await jobs.runOnce()).toBe(0);
          vi.setSystemTime(Date.now() + HOUR);
          expect(await jobs.runOnce()).toBe(1);
          expect(runs).toBe(1);
        });
      },
    },
    {
      name: "a failed attempt is retried later, not immediately",
      async check(jobs) {
        await withFakeDate(async () => {
          const attempts: number[] = [];
          jobs.handle("test/flaky", async (job) => {
            attempts.push(job.attempt);
            if (job.attempt === 1) throw new Error("first attempt fails");
          });
          await jobs.enqueue("test/flaky", {});
          expect(await jobs.runOnce()).toBe(1);
          expect(await jobs.runOnce()).toBe(0);
          expect((await jobs.stats()).pending).toBe(1);
          vi.setSystemTime(Date.now() + HOUR);
          expect(await jobs.runOnce()).toBe(1);
          expect(attempts).toEqual([1, 2]);
          expect((await jobs.stats()).done).toBe(1);
        });
      },
    },
    {
      name: "a job that fails maxAttempts times is dead and never runs again",
      async check(jobs) {
        await withFakeDate(async () => {
          let runs = 0;
          jobs.handle("test/broken", async () => {
            runs += 1;
            throw new Error("always fails");
          });
          await jobs.enqueue("test/broken", {}, { maxAttempts: 2 });
          for (let i = 0; i < 4; i++) {
            await jobs.runOnce();
            vi.setSystemTime(Date.now() + HOUR);
          }
          expect(runs).toBe(2);
          expect(await jobs.stats()).toEqual({
            pending: 0,
            running: 0,
            done: 0,
            dead: 1,
          });
        });
      },
    },
    {
      name: "concurrent runOnce calls never run the same job twice",
      async check(jobs) {
        const counts = new Map<string, number>();
        jobs.handle("test/job", async (job) => {
          counts.set(job.id, (counts.get(job.id) ?? 0) + 1);
        });
        const ids = [];
        for (let i = 0; i < 10; i++)
          ids.push(await jobs.enqueue("test/job", { i }));
        while (
          (await Promise.all([jobs.runOnce(), jobs.runOnce()])).some(Boolean)
        );
        expect([...counts.keys()].toSorted()).toEqual(ids.toSorted());
        expect([...counts.values()].every((count) => count === 1)).toBe(true);
      },
    },
    {
      name: "registering a second handler for a type throws, and removing it frees the type",
      check(jobs) {
        const remove = jobs.handle("test/job", async () => {});
        expect(() => jobs.handle("test/job", async () => {})).toThrow();
        remove();
        expect(() => jobs.handle("test/job", async () => {})).not.toThrow();
      },
    },
  ],
);
