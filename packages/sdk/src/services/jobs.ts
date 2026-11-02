/** A queued unit of work handed to the handler of its `type`. */
export interface Job {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly attempt: number;
}

/** Options for `jobs.enqueue`. */
export interface EnqueueOptions {
  /** Earliest run time in ms since epoch. Defaults to now. */
  runAt?: number;
  /** Total attempts before the job is marked dead. Defaults to 3. */
  maxAttempts?: number;
}

/** Number of jobs in each state. */
export interface JobStats {
  pending: number;
  running: number;
  done: number;
  dead: number;
}

/**
 * A durable job queue with retries and leases, stored through `storage`.
 *
 * @stability experimental
 */
export interface JobsService {
  /** Registers the handler for `type`; the returned function removes it. */
  handle(type: string, handler: (job: Job) => Promise<void>): () => void;
  enqueue(
    type: string,
    payload: unknown,
    options?: EnqueueOptions,
  ): Promise<string>;
  /**
   * Claims up to the concurrency limit of due jobs that have a handler, runs them, and resolves
   * once they settle. Failed jobs retry with exponential backoff until `maxAttempts`, then die.
   * A claimed attempt holds a lease that its worker renews while the handler runs; an attempt
   * whose worker stopped (its lease ran out) counts as failed, so another worker retries the job
   * or marks it dead. Handlers must therefore tolerate running more than once for one job.
   * Returns the number of jobs started.
   */
  runOnce(): Promise<number>;
  stats(): Promise<JobStats>;
}
