import type { SearchDocument, SearchService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { searchConformanceSuite } from "./search.ts";

const keyOf = (collection: string, spaceId: string, entryId: string) =>
  JSON.stringify([collection, spaceId, entryId]);

/** Violates "only documents of the requested spaces are returned": ignores `spaceIds`. */
function createBrokenSearchService(): SearchService {
  const documents = new Map<string, SearchDocument & { collection: string }>();
  return {
    async index(collection, added) {
      for (const document of added) {
        documents.set(keyOf(collection, document.spaceId, document.entryId), {
          ...document,
          collection,
        });
      }
    },
    async remove(collection, spaceId, entryIds) {
      for (const [key, document] of documents) {
        if (
          document.collection === collection &&
          document.spaceId === spaceId &&
          (entryIds === undefined || entryIds.includes(document.entryId))
        ) {
          documents.delete(key);
        }
      }
    },
    async clear(collection) {
      for (const [key, document] of documents) {
        if (document.collection === collection) documents.delete(key);
      }
    },
    async query(collection, query) {
      const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      return [...documents.values()]
        .filter(
          (document) =>
            document.collection === collection &&
            words.every((word) =>
              `${document.title} ${document.text}`.toLowerCase().includes(word),
            ),
        )
        .slice(0, query.limit ?? 20)
        .map((document) => ({
          spaceId: document.spaceId,
          entryId: document.entryId,
          revision: document.revision,
          title: document.title,
          snippet: document.text,
          score: 1,
        }));
    },
  };
}

describe("a deliberately broken search implementation", () => {
  it("fails the space-filter invariant the suite is meant to catch", async () => {
    const invariant = searchConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "only documents of the requested spaces are returned",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      invariant.check(createBrokenSearchService()),
    ).rejects.toThrow();
  });
});
