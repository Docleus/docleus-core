import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DocleusError, type Context } from "@docleus/kernel";
import type { BlobEntry, BlobsService, BlobStat } from "@docleus/sdk";

function hashOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new DocleusError(
      "blobs/invalid-hash",
      `"${hash}" is not a SHA-256 hex digest`,
    );
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new DocleusError("blobs/list-failed", `cannot list "${dir}"`, {
      cause: error,
    });
  }
}

/** Walks `<dir>/ab/cd/<hash>`, skipping temporary and foreign files. */
async function* entriesIn(dir: string): AsyncGenerator<BlobEntry> {
  for (const first of await namesIn(dir)) {
    if (!SHARD_PATTERN.test(first)) continue;
    for (const second of await namesIn(join(dir, first))) {
      if (!SHARD_PATTERN.test(second)) continue;
      const shard = join(dir, first, second);
      for (const hash of await namesIn(shard)) {
        if (!HASH_PATTERN.test(hash) || !hash.startsWith(first + second)) {
          continue;
        }
        try {
          const info = await stat(join(shard, hash));
          yield { hash, size: info.size, storedAt: info.mtimeMs };
        } catch (error) {
          // Deleted while listing.
          if (isMissing(error)) continue;
          throw new DocleusError(
            "blobs/list-failed",
            `cannot stat blob "${hash}"`,
            { cause: error },
          );
        }
      }
    }
  }
}

function pathFor(dir: string, hash: string): string {
  assertHash(hash);
  // Two levels of hash-prefix sharding keep any one directory small.
  return join(dir, hash.slice(0, 2), hash.slice(2, 4), hash);
}

function sign(secret: Buffer, hash: string, expiresAt: number): string {
  const payload = `${hash}.${expiresAt}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

function verify(secret: Buffer, token: string): string | undefined {
  const lastDot = token.lastIndexOf(".");
  const middleDot = token.lastIndexOf(".", lastDot - 1);
  if (lastDot < 0 || middleDot < 0) return undefined;
  const hash = token.slice(0, middleDot);
  const expiresAt = Number(token.slice(middleDot + 1, lastDot));
  const mac = token.slice(lastDot + 1);
  const expected = createHmac("sha256", secret)
    .update(token.slice(0, lastDot))
    .digest("hex");
  const macBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (macBuffer.length !== expectedBuffer.length) return undefined;
  if (!timingSafeEqual(macBuffer, expectedBuffer)) return undefined;
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return undefined;
  return hash;
}

/**
 * Default `blobs` implementation: content-addressed storage in a local
 * directory, with HMAC-signed read tokens.
 *
 * @stability experimental
 */
export function createBlobsService(
  dir: string,
  secret: Buffer = randomBytes(32),
): BlobsService {
  return {
    async put(data) {
      const hash = hashOf(data);
      const path = pathFor(dir, hash);
      await mkdir(join(path, ".."), { recursive: true });
      // Rename is atomic, so a concurrent get never sees a partial file.
      // Writing even when the blob exists refreshes its `storedAt`.
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, data);
      await rename(temporary, path);
      return { hash, size: data.byteLength };
    },
    async get(hash) {
      const path = pathFor(dir, hash);
      try {
        return await readFile(path);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw new DocleusError(
          "blobs/read-failed",
          `cannot read blob "${hash}"`,
          {
            cause: error,
          },
        );
      }
    },
    async stat(hash): Promise<BlobStat | undefined> {
      const path = pathFor(dir, hash);
      try {
        const info = await stat(path);
        return { hash, size: info.size };
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw new DocleusError(
          "blobs/stat-failed",
          `cannot stat blob "${hash}"`,
          {
            cause: error,
          },
        );
      }
    },
    async delete(hash) {
      const path = pathFor(dir, hash);
      try {
        await rm(path);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw new DocleusError(
          "blobs/delete-failed",
          `cannot delete blob "${hash}"`,
          { cause: error },
        );
      }
    },
    list: () => entriesIn(dir),
    sign(hash, expiresAt) {
      assertHash(hash);
      return sign(secret, hash, expiresAt);
    },
    verify: (token) => verify(secret, token),
  };
}

export function provideBlobs(
  ctx: Context,
  dir: string,
  secret?: Buffer,
): () => void {
  return ctx.provide("blobs", createBlobsService(dir, secret));
}
