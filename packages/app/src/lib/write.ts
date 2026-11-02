/** A failed write the user was already told about; callers may drop it. */
export class ReportedError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "ReportedError";
  }
}

/** Runs a write whose failure `write` already reported. */
export function fireWrite(write: Promise<unknown>): void {
  write.catch((error: unknown) => {
    if (!(error instanceof ReportedError)) throw error;
  });
}
