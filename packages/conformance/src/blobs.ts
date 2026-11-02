import type { BlobEntry, BlobsService } from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

const text = (value: string) => new TextEncoder().encode(value);
// Remote stores stamp `storedAt` with their own clock.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

async function listed(blobs: BlobsService): Promise<BlobEntry[] | undefined> {
  if (!blobs.list) return undefined;
  const entries: BlobEntry[] = [];
  for await (const entry of blobs.list()) entries.push(entry);
  return entries.toSorted((a, b) => (a.hash < b.hash ? -1 : 1));
}

export const blobsConformanceSuite = defineConformanceSuite<BlobsService>(
  "blobs",
  [
    {
      name: "put returns the SHA-256 hash and byte size",
      async check(blobs) {
        const stat = await blobs.put(text("hello"));
        expect(stat.hash).toBe(
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        );
        expect(stat.size).toBe(5);
      },
    },
    {
      name: "get returns exactly the bytes that were put",
      async check(blobs) {
        const { hash } = await blobs.put(text("round trip"));
        const bytes = await blobs.get(hash);
        expect(bytes && new TextDecoder().decode(bytes)).toBe("round trip");
      },
    },
    {
      name: "get on an unknown hash returns undefined, not an error",
      async check(blobs) {
        expect(await blobs.get("0".repeat(64))).toBeUndefined();
      },
    },
    {
      name: "storing identical bytes twice stores them once under the same hash",
      async check(blobs) {
        const a = await blobs.put(text("same"));
        const b = await blobs.put(text("same"));
        expect(a.hash).toBe(b.hash);
        expect(await blobs.get(a.hash)).toEqual(await blobs.get(b.hash));
      },
    },
    {
      name: "stat reports the size without returning the bytes",
      async check(blobs) {
        const { hash } = await blobs.put(text("sized"));
        expect(await blobs.stat(hash)).toEqual({ hash, size: 5 });
      },
    },
    {
      name: "stat on an unknown hash returns undefined",
      async check(blobs) {
        expect(await blobs.stat("0".repeat(64))).toBeUndefined();
      },
    },
    {
      name: "delete removes the blob and reports it was present",
      async check(blobs) {
        const { hash } = await blobs.put(text("gone soon"));
        expect(await blobs.delete(hash)).toBe(true);
        expect(await blobs.get(hash)).toBeUndefined();
      },
    },
    {
      name: "delete on an unknown hash returns false",
      async check(blobs) {
        expect(await blobs.delete("0".repeat(64))).toBe(false);
      },
    },
    {
      name: "list, when implemented, yields every stored blob once with its size and when it was stored",
      async check(blobs) {
        const before = Date.now();
        const a = await blobs.put(text("listed a"));
        const b = await blobs.put(text("listed bb"));
        await blobs.put(text("listed a"));
        const after = Date.now();
        const entries = await listed(blobs);
        if (!entries) return;
        expect(entries.map(({ hash, size }) => ({ hash, size }))).toEqual(
          [a, b].toSorted((x, y) => (x.hash < y.hash ? -1 : 1)),
        );
        for (const entry of entries) {
          expect(entry.storedAt).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MS);
          expect(entry.storedAt).toBeLessThanOrEqual(after + CLOCK_SKEW_MS);
        }
      },
    },
    {
      name: "list, when implemented, leaves out deleted blobs",
      async check(blobs) {
        const kept = await blobs.put(text("kept"));
        const gone = await blobs.put(text("deleted"));
        await blobs.delete(gone.hash);
        const entries = await listed(blobs);
        if (!entries) return;
        expect(entries.map((entry) => entry.hash)).toEqual([kept.hash]);
      },
    },
    {
      name: "verify accepts a token sign issued for the same hash before it expires",
      async check(blobs) {
        const { hash } = await blobs.put(text("signed"));
        const token = blobs.sign(hash, Date.now() + 60_000);
        expect(blobs.verify(token)).toBe(hash);
      },
    },
    {
      name: "verify rejects an expired token",
      async check(blobs) {
        const { hash } = await blobs.put(text("expired"));
        const token = blobs.sign(hash, Date.now() - 1);
        expect(blobs.verify(token)).toBeUndefined();
      },
    },
    {
      name: "verify rejects a tampered token",
      async check(blobs) {
        const { hash } = await blobs.put(text("tamper"));
        const token = blobs.sign(hash, Date.now() + 60_000);
        expect(blobs.verify(`${token}x`)).toBeUndefined();
      },
    },
    {
      name: "verify rejects a token whose expiry was extended",
      async check(blobs) {
        const { hash } = await blobs.put(text("extend"));
        const expiresAt = Date.now() + 60_000;
        const token = blobs.sign(hash, expiresAt);
        const extended = token.replace(
          String(expiresAt),
          String(expiresAt + 3_600_000),
        );
        expect(extended).not.toBe(token);
        expect(blobs.verify(extended)).toBeUndefined();
      },
    },
    {
      name: "get, stat and delete reject a hash that is not a SHA-256 hex digest",
      async check(blobs) {
        for (const hash of ["../../etc/passwd", "ABC", "", "a".repeat(63)]) {
          await expectToReject(() => blobs.get(hash));
          await expectToReject(() => blobs.stat(hash));
          await expectToReject(() => blobs.delete(hash));
        }
      },
    },
  ],
);
