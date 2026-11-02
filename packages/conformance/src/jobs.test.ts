import type { Job, JobsService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { jobsConformanceSuite } from "./jobs.ts";

/** Violates "dead after maxAttempts": ignores maxAttempts and retries forever. */
function createBrokenJobsService(): JobsService {
  const handlers = new Map<string, (job: Job) => Promise<void>>();
  const queue: { job: Job; runAt: number; status: "pending" | "done" }[] = [];
  let nextId = 0;
  return {
    handle(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    async enqueue(type, payload, options = {}) {
      const id = String(nextId++);
      queue.push({
        job: { id, type, payload, attempt: 0 },
        runAt: options.runAt ?? Date.now(),
        status: "pending",
      });
      return id;
    },
    async runOnce() {
      let started = 0;
      for (const entry of queue) {
        const handler = handlers.get(entry.job.type);
        if (!handler || entry.status !== "pending") continue;
        if (entry.runAt > Date.now()) continue;
        started += 1;
        entry.job = { ...entry.job, attempt: entry.job.attempt + 1 };
        try {
          await handler(entry.job);
          entry.status = "done";
        } catch {
          entry.runAt = Date.now() + 1;
        }
      }
      return started;
    },
    async stats() {
      const pending = queue.filter((e) => e.status === "pending").length;
      return { pending, running: 0, done: queue.length - pending, dead: 0 };
    },
  };
}

describe("a deliberately broken jobs implementation", () => {
  it("fails the dead-letter invariant the suite is meant to catch", async () => {
    const invariant = jobsConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "a job that fails maxAttempts times is dead and never runs again",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenJobsService())),
    ).rejects.toThrow();
  });
});
