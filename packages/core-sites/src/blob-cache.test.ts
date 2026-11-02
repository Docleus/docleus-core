import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@docleus/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobCache, type BlobCache } from "./blob-cache.ts";

const dirs: string[] = [];
const logger = new Context().logger("test");

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-site-cache-"));
  dirs.push(dir);
  return dir;
}

function blob(content: string): { hash: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(content);
  return { hash: createHash("sha256").update(bytes).digest("hex"), bytes };
}

/** A blob store that counts its reads. */
function store(...blobs: { hash: string; bytes: Uint8Array }[]) {
  const byHash = new Map(blobs.map(({ hash, bytes }) => [hash, bytes]));
  const reads: string[] = [];
  return {
    reads,
    load: async (hash: string) => {
      reads.push(hash);
      return byHash.get(hash);
    },
  };
}

function text(bytes: Uint8Array | undefined): string | undefined {
  return bytes && new TextDecoder().decode(bytes);
}

async function cachedFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  const files: string[] = [];
  for (const name of names) {
    if ((await stat(join(dir, name))).isFile()) files.push(name);
  }
  return files.toSorted();
}

describe("createBlobCache", () => {
  it("serves a second read from disk without asking the store", async () => {
    const dir = await tempDir();
    const a = blob("alpha");
    const source = store(a);
    const cache = createBlobCache({ dir, maxBytes: 1024 }, logger);

    expect(text(await cache.read(a.hash, source.load))).toBe("alpha");
    expect(text(await cache.read(a.hash, source.load))).toBe("alpha");
    expect(source.reads).toEqual([a.hash]);
  });

  it("keeps entries for a new cache on the same directory", async () => {
    const dir = await tempDir();
    const a = blob("survives a restart");
    await createBlobCache({ dir, maxBytes: 1024 }, logger).read(
      a.hash,
      store(a).load,
    );

    const source = store(a);
    const restarted: BlobCache = createBlobCache(
      { dir, maxBytes: 1024 },
      logger,
    );
    expect(text(await restarted.read(a.hash, source.load))).toBe(
      "survives a restart",
    );
    expect(source.reads).toEqual([]);
  });

  it("evicts the least recently read entries to stay under the cap", async () => {
    const dir = await tempDir();
    const blobs = ["a", "b", "c"].map((name) => blob(name.repeat(40)));
    const [a, b, c] = blobs as [
      ReturnType<typeof blob>,
      ReturnType<typeof blob>,
      ReturnType<typeof blob>,
    ];
    const source = store(...blobs);
    const cache = createBlobCache({ dir, maxBytes: 100 }, logger);

    await cache.read(a.hash, source.load);
    await cache.read(b.hash, source.load);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, a.hash.slice(0, 2), a.hash), old, old);
    await utimes(join(dir, b.hash.slice(0, 2), b.hash), old, old);
    await cache.read(a.hash, source.load);
    await cache.read(c.hash, source.load);

    const files = await cachedFiles(dir);
    const sizes = await Promise.all(
      files.map(async (file) => (await stat(join(dir, file))).size),
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(100);
    expect(files.map((file) => file.split("/").at(-1))).toEqual(
      [a.hash, c.hash].toSorted(),
    );
    expect(source.reads).toEqual([a.hash, b.hash, c.hash]);
  });

  it("does not cache a blob larger than the cap", async () => {
    const dir = await tempDir();
    const big = blob("x".repeat(200));
    const source = store(big);
    const cache = createBlobCache({ dir, maxBytes: 100 }, logger);

    expect(text(await cache.read(big.hash, source.load))).toBe("x".repeat(200));
    expect(await cachedFiles(dir)).toEqual([]);
  });

  it("falls back to the store for a corrupt entry and repairs it", async () => {
    const dir = await tempDir();
    const a = blob("intact");
    const cache = createBlobCache({ dir, maxBytes: 1024 }, logger);
    await cache.read(a.hash, store(a).load);
    await writeFile(join(dir, a.hash.slice(0, 2), a.hash), "garbage");

    const source = store(a);
    expect(text(await cache.read(a.hash, source.load))).toBe("intact");
    expect(source.reads).toEqual([a.hash]);
    expect(text(await cache.read(a.hash, source.load))).toBe("intact");
    expect(source.reads).toEqual([a.hash]);
  });

  it("reports a blob missing from the store as missing and caches nothing", async () => {
    const dir = await tempDir();
    const absent = blob("never stored");
    const cache = createBlobCache({ dir, maxBytes: 1024 }, logger);

    expect(await cache.read(absent.hash, store().load)).toBeUndefined();
    expect(await cachedFiles(dir)).toEqual([]);
  });

  it("does not cache bytes that do not match the requested hash", async () => {
    const dir = await tempDir();
    const a = blob("asked for");
    const wrong = blob("got this");
    const cache = createBlobCache({ dir, maxBytes: 1024 }, logger);

    await cache.read(a.hash, async () => wrong.bytes);
    expect(await cachedFiles(dir)).toEqual([]);
  });

  it("reads straight from the store when disabled", async () => {
    const dir = await tempDir();
    const a = blob("uncached");
    const source = store(a);
    const cache = createBlobCache({ dir, maxBytes: 0 }, logger);

    await cache.read(a.hash, source.load);
    await cache.read(a.hash, source.load);
    expect(source.reads).toEqual([a.hash, a.hash]);
    expect(await cachedFiles(dir)).toEqual([]);
  });
});
