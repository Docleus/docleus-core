/** Runs tasks one after another, so read-check-write sequences do not interleave. */
export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(() => task());
    // The chain only orders tasks; each caller still sees its own rejection.
    tail = run.catch(() => undefined);
    return run;
  };
}
