import { createHash } from "node:crypto";
import type { BlobsService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { blobsConformanceSuite } from "./blobs.ts";

/** Violates "storing identical bytes twice stores them once": ignores content, hashes by insertion order. */
function createBrokenBlobsService(): BlobsService {
  const store = new Map<string, Uint8Array>();
  let counter = 0;
  return {
    async put(data) {
      const hash = String(counter++).padStart(64, "0");
      store.set(hash, data);
      return { hash, size: data.byteLength };
    },
    async get(hash) {
      return store.get(hash);
    },
    async stat(hash) {
      const data = store.get(hash);
      return data && { hash, size: data.byteLength };
    },
    async delete(hash) {
      return store.delete(hash);
    },
    async *list() {
      for (const [hash, data] of store) {
        yield { hash, size: data.byteLength, storedAt: Date.now() };
      }
    },
    sign: (hash, expiresAt) => `${hash}.${expiresAt}`,
    verify: (token) => token.split(".")[0],
  };
}

describe("a deliberately broken blobs implementation", () => {
  it("fails the content-addressing invariant the suite is meant to catch", async () => {
    const broken = createBrokenBlobsService();
    const invariant = blobsConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "storing identical bytes twice stores them once under the same hash",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(invariant.check(broken)).rejects.toThrow();
  });
});

/** Violates the `storedAt` of "list ... yields every stored blob": reports every blob as stored at the epoch, so garbage collection would delete fresh uploads. */
function createStaleListBlobsService(): BlobsService {
  const store = new Map<string, Uint8Array>();
  return {
    async put(data) {
      const hash = createHash("sha256").update(data).digest("hex");
      store.set(hash, data);
      return { hash, size: data.byteLength };
    },
    get: async (hash) => store.get(hash),
    async stat(hash) {
      const data = store.get(hash);
      return data && { hash, size: data.byteLength };
    },
    delete: async (hash) => store.delete(hash),
    async *list() {
      for (const [hash, data] of store) {
        yield { hash, size: data.byteLength, storedAt: 0 };
      }
    },
    sign: (hash, expiresAt) => `${hash}.${expiresAt}`,
    verify: (token) => token.split(".")[0],
  };
}

describe("a blobs implementation whose list reports stale times", () => {
  it("fails the list invariant", async () => {
    const invariant = blobsConformanceSuite.invariants.find((candidate) =>
      candidate.name.startsWith("list, when implemented, yields every"),
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      invariant.check(createStaleListBlobsService()),
    ).rejects.toThrow();
  });
});
