import { sql, type Kysely } from "kysely";

export type JobStatus = "pending" | "running" | "done" | "dead";

export interface JobsTable {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  /** Attempts started so far. */
  attempt: number;
  max_attempts: number;
  run_at: number;
  last_error: string | null;
  /** While `running`: when the attempt is presumed dead unless its worker renews the lease. */
  lease_until: number | null;
}

export interface JobsSchema {
  jobs: JobsTable;
}

export const jobsMigrations = [
  {
    id: "0001-create-tables",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<JobsSchema>;
      await typed.schema
        .createTable("jobs")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("type", "text", (c) => c.notNull())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("max_attempts", "integer", (c) => c.notNull())
        .addColumn("run_at", "integer", (c) => c.notNull())
        .addColumn("last_error", "text")
        .execute();
      await sql`create index if not exists jobs_due on jobs (status, run_at)`.execute(
        typed,
      );
    },
  },
  {
    id: "0002-add-lease",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<JobsSchema>;
      await typed.schema
        .alterTable("jobs")
        .addColumn("lease_until", "integer")
        .execute();
      // Attempts started before leases existed have no worker renewing them.
      await typed
        .updateTable("jobs")
        .set({ lease_until: 0 })
        .where("status", "=", "running")
        .execute();
    },
  },
];
