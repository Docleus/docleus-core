import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blobsConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import { afterEach, describe, expect, it } from "vitest";
import type { BlobEntry } from "@docleus/sdk";
import { createBlobsService } from "./index.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-blobs-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

runConformanceSuite(blobsConformanceSuite, async () =>
  createBlobsService(await tempDir()),
);

describe("createBlobsService", () => {
  it("shards blobs into subdirectories by hash prefix so no directory grows unbounded", async () => {
    const dir = await tempDir();
    const blobs = createBlobsService(dir);
    const { hash } = await blobs.put(new TextEncoder().encode("sharded"));

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual([hash.slice(0, 2)]);
  });

  it("lists only blob files, not temporary or foreign ones", async () => {
    const dir = await tempDir();
    const blobs = createBlobsService(dir);
    const { hash } = await blobs.put(new TextEncoder().encode("listed"));
    const shard = join(dir, hash.slice(0, 2), hash.slice(2, 4));
    await writeFile(join(shard, `${hash}.0123.tmp`), "partial");
    await writeFile(join(shard, "a".repeat(64)), "misplaced");
    await mkdir(join(dir, "zz"));
    await writeFile(join(dir, "notes.txt"), "foreign");

    const entries: BlobEntry[] = [];
    for await (const entry of blobs.list?.() ?? []) entries.push(entry);
    expect(entries.map((entry) => entry.hash)).toEqual([hash]);
  });

  it("refreshes storedAt when the same bytes are put again", async () => {
    const dir = await tempDir();
    const blobs = createBlobsService(dir);
    const data = new TextEncoder().encode("refreshed");
    const { hash } = await blobs.put(data);
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, hash.slice(0, 2), hash.slice(2, 4), hash), old, old);

    const before = Date.now();
    await blobs.put(data);
    const entries: BlobEntry[] = [];
    for await (const entry of blobs.list?.() ?? []) entries.push(entry);
    expect(entries[0]?.storedAt).toBeGreaterThanOrEqual(before - 1000);
  });

  it("uses a fresh signing secret per service instance", async () => {
    const dir = await tempDir();
    const a = createBlobsService(dir);
    const b = createBlobsService(dir);
    const { hash } = await a.put(new TextEncoder().encode("cross-instance"));

    const token = a.sign(hash, Date.now() + 60_000);
    expect(b.verify(token)).toBeUndefined();
  });
});

describe("createBlobsService with a shared secret", () => {
  it("verifies tokens signed by another instance with the same secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docleus-blobs-"));
    try {
      const secret = Buffer.alloc(32, 7);
      const a = createBlobsService(dir, secret);
      const b = createBlobsService(dir, secret);
      const { hash } = await a.put(new TextEncoder().encode("shared"));
      expect(b.verify(a.sign(hash, Date.now() + 60_000))).toBe(hash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
