import type { Context } from "@docleus/kernel";

/** How long the job loop waits when the queue was empty. */
export const JOB_POLL_INTERVAL_MS = 1000;

/**
 * Runs due jobs until `ctx` is disposed: right away while there is work,
 * otherwise every `intervalMs`.
 */
export function runJobLoop(
  ctx: Context,
  intervalMs = JOB_POLL_INTERVAL_MS,
): void {
  const logger = ctx.logger("jobs");
  ctx.effect(() => {
    let timer: NodeJS.Timeout | undefined;
    let isStopped = false;
    let current: Promise<void> = Promise.resolve();
    const tick = async () => {
      let started = 0;
      try {
        started = await ctx.jobs.runOnce();
      } catch (error) {
        logger.warn("running jobs failed: %s", error);
      }
      if (!isStopped)
        timer = setTimeout(schedule, started > 0 ? 0 : intervalMs);
    };
    const schedule = () => {
      current = tick();
    };
    timer = setTimeout(schedule, 0);
    return async () => {
      isStopped = true;
      clearTimeout(timer);
      await current;
    };
  }, "job loop");
}
