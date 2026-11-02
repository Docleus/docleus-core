/** The hash and size in bytes of a stored blob. */
export interface BlobStat {
  readonly hash: string;
  readonly size: number;
}

/**
 * How stale {@link BlobEntry.storedAt} may be right after `put`: storing
 * bytes that are already there may skip the write while the stored copy is
 * younger than this. Blob garbage collection relies on it.
 *
 * @stability experimental
 */
export const BLOB_PUT_REFRESH_MS = 60 * 60 * 1000;

/** A stored blob as {@link BlobsService.list} reports it. */
export interface BlobEntry extends BlobStat {
  /**
   * When the blob was last written, in ms since epoch. `put` of bytes that
   * are already stored leaves it at most {@link BLOB_PUT_REFRESH_MS} old.
   */
  readonly storedAt: number;
}

/**
 * Input of the `blobs/mark` event: listeners mark every blob hash they
 * keep a reference to.
 *
 * @stability experimental
 */
export interface BlobMarkInput {
  mark(hash: string): void;
}

/**
 * Content-addressed binary storage with signed read tokens.
 *
 * @stability experimental
 */
export interface BlobsService {
  /** Stores bytes and returns their lowercase hex SHA-256. Identical bytes are stored once. */
  put(data: Uint8Array): Promise<BlobStat>;
  get(hash: string): Promise<Uint8Array | undefined>;
  stat(hash: string): Promise<BlobStat | undefined>;
  delete(hash: string): Promise<boolean>;
  /**
   * Yields every stored blob once, in no particular order; blobs put or
   * deleted meanwhile may or may not appear. Optional: blob garbage
   * collection skips an implementation without it.
   */
  list?(): AsyncIterable<BlobEntry>;
  /** Returns a token that grants read access to one blob until `expiresAt` (ms since epoch). */
  sign(hash: string, expiresAt: number): string;
  /** Returns the blob hash the token grants, or undefined when invalid or expired. */
  verify(token: string): string | undefined;
}
