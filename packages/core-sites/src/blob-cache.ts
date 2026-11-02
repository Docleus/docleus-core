import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@docleus/sdk";

type Logger = ReturnType<Context["logger"]>;

/** The cache size when the deployment config sets none: 512 MiB. */
export const DEFAULT_SITE_CACHE_MAX_BYTES = 512 * 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
// Evicting down to a little below the cap keeps one write from evicting again right away.
const LOW_WATERMARK = 0.9;
// A temporary file this old belongs to a write that died.
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

export interface SiteCacheOptions {
  /** A directory only this cache writes to, such as `<dataDir>/cache/blobs`. */
  readonly dir: string;
  /** Bytes the cache keeps on disk; the least recently read entries go first. 0 disables it. */
  readonly maxBytes: number;
}

/**
 * A read-through cache of blobs on the local disk, for serving sites from
 * a remote blob store without a round-trip per request. Blobs are
 * content-addressed, so an entry never goes stale; one whose bytes do not
 * hash to its name is a miss. Several processes may share the directory.
 */
export interface BlobCache {
  read(
    hash: string,
    load: (hash: string) => Promise<Uint8Array | undefined>,
  ): Promise<Uint8Array | undefined>;
}

interface Entry {
  readonly path: string;
  readonly size: number;
  readonly usedAt: number;
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** A cache that reads straight from `load`. */
export const NO_BLOB_CACHE: BlobCache = {
  read: (hash, load) => load(hash),
};

export function createBlobCache(
  options: SiteCacheOptions,
  logger: Logger,
): BlobCache {
  if (options.maxBytes <= 0) return NO_BLOB_CACHE;
  const { dir, maxBytes } = options;
  // Bytes this process believes are on disk; other processes sharing the
  // directory are counted at the next scan.
  let used: number | undefined;
  let eviction: Promise<void> | undefined;

  const pathOf = (hash: string) => join(dir, hash.slice(0, 2), hash);

  async function scan(now: number): Promise<Entry[]> {
    let names: string[];
    try {
      names = await readdir(dir, { recursive: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const entries: Entry[] = [];
    for (const name of names) {
      const path = join(dir, name);
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!info.isFile()) continue;
      if (name.endsWith(".tmp")) {
        if (now - info.mtimeMs > STALE_TEMPORARY_MS)
          await rm(path, { force: true });
        continue;
      }
      entries.push({ path, size: info.size, usedAt: info.mtimeMs });
    }
    return entries;
  }

  async function evict(): Promise<void> {
    const entries = (await scan(Date.now())).toSorted(
      (a, b) => a.usedAt - b.usedAt,
    );
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const target = Math.floor(maxBytes * LOW_WATERMARK);
    for (const entry of entries) {
      if (total <= target) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
    used = total;
  }

  async function account(size: number): Promise<void> {
    used ??= (await scan(Date.now())).reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    used += size;
    if (used <= maxBytes) return;
    eviction ??= evict().finally(() => {
      eviction = undefined;
    });
    await eviction;
  }

  async function readCached(hash: string): Promise<Uint8Array | undefined> {
    const path = pathOf(hash);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (hashOf(bytes) !== hash) {
      logger.warn("dropping corrupt cache entry %s", hash);
      await rm(path, { force: true });
      return undefined;
    }
    const now = new Date();
    try {
      await utimes(path, now, now);
    } catch (error) {
      // Evicted by another process between the read and the touch.
      if (!isMissing(error)) throw error;
    }
    return bytes;
  }

  async function write(hash: string, bytes: Uint8Array): Promise<void> {
    const path = pathOf(hash);
    await mkdir(join(path, ".."), { recursive: true });
    // Rename is atomic, so a concurrent reader never sees a partial file.
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    await account(bytes.byteLength);
  }

  return {
    async read(hash, load) {
      if (!HASH_PATTERN.test(hash)) return load(hash);
      try {
        const cached = await readCached(hash);
        if (cached) return cached;
      } catch (error) {
        logger.warn("cannot read cache entry %s: %s", hash, error);
      }
      const bytes = await load(hash);
      if (!bytes || bytes.byteLength > maxBytes || hashOf(bytes) !== hash) {
        return bytes;
      }
      try {
        await write(hash, bytes);
      } catch (error) {
        // The cache only saves round-trips; serving goes on without it.
        logger.warn("cannot cache blob %s: %s", hash, error);
      }
      return bytes;
    },
  };
}
