export class DocleusError extends Error {
  override readonly name = "DocleusError";

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
