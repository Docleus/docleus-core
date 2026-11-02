import { randomBytes } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocleusError } from "@docleus/kernel";

/** The file in the data directory that keeps a generated blob signing secret. */
export const BLOB_SECRET_FILE = "blob-secret";

/** The shortest blob signing secret accepted, in characters. */
export const MIN_BLOB_SECRET_LENGTH = 32;

/**
 * Returns `secret` as the bytes that sign blob URLs. Throws a
 * `config/invalid-blob-secret` error naming `source` when it is shorter than
 * {@link MIN_BLOB_SECRET_LENGTH}.
 */
export function checkBlobSecret(secret: string, source: string): Buffer {
  if (secret.length < MIN_BLOB_SECRET_LENGTH) {
    throw new DocleusError(
      "config/invalid-blob-secret",
      `${source} must be at least ${MIN_BLOB_SECRET_LENGTH} characters`,
    );
  }
  return Buffer.from(secret, "utf8");
}

/**
 * The secret that signs blob URLs: `secret` when given, else the one kept
 * in `<dataDir>/blob-secret`, generated on first use so that restarts and
 * processes sharing the data directory (`web` and `worker`) agree on it.
 * Without a data directory, a random secret for this process only.
 */
export async function resolveBlobSecret(
  secret: string | undefined,
  dataDir: string | undefined,
): Promise<Buffer> {
  if (secret !== undefined) return checkBlobSecret(secret, "the blob secret");
  if (dataDir === undefined) return randomBytes(32);
  const file = join(dataDir, BLOB_SECRET_FILE);
  // Random, not the pid: processes in separate containers can share a pid.
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${randomBytes(32).toString("hex")}\n`, {
    mode: 0o600,
  });
  try {
    // `link` never replaces an existing file, so processes booting together
    // on one data directory all keep whichever complete secret landed first.
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return checkBlobSecret((await readFile(file, "utf8")).trim(), file);
}
