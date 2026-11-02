import type { SearchDocument, SearchService } from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite } from "./suite.ts";

const SPACE = "space-1";
const OTHER_SPACE = "space-2";
const COLLECTION = "main";

function doc(
  entryId: string,
  title: string,
  text: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  return { spaceId: SPACE, entryId, revision: "r1", title, text, ...overrides };
}

async function ids(
  search: SearchService,
  text: string,
  options: { collection?: string; spaceIds?: readonly string[] } = {},
): Promise<string[]> {
  const hits = await search.query(options.collection ?? COLLECTION, {
    text,
    spaceIds: options.spaceIds ?? [SPACE],
  });
  return hits.map((hit) => hit.entryId).toSorted();
}

/**
 * Invariants of the `search` key. Every subject starts empty. Ranking is
 * only checked where any full-text engine agrees: a title match outranks a
 * body-only match, and hits come best first.
 */
export const searchConformanceSuite = defineConformanceSuite<SearchService>(
  "search",
  [
    {
      name: "a document is found by a word of its title",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Installation guide", "Nothing else here."),
          doc("b", "Reference", "Unrelated words."),
        ]);
        expect(await ids(search, "installation")).toEqual(["a"]);
      },
    },
    {
      name: "a document is found by a word of its text",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "Configure the webhook endpoint."),
          doc("b", "Reference", "Unrelated words."),
        ]);
        expect(await ids(search, "webhook")).toEqual(["a"]);
      },
    },
    {
      name: "words match regardless of case",
      async check(search) {
        await search.index(COLLECTION, [doc("a", "Deploy", "Use Kubernetes.")]);
        expect(await ids(search, "KUBERNETES")).toEqual(["a"]);
        expect(await ids(search, "deploy")).toEqual(["a"]);
      },
    },
    {
      name: "words with non-ASCII letters are found",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Größe", "Le café est prêt."),
        ]);
        expect(await ids(search, "café")).toEqual(["a"]);
        expect(await ids(search, "größe")).toEqual(["a"]);
      },
    },
    {
      name: "the last word of the query also matches as a prefix",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "Run the installer first."),
        ]);
        expect(await ids(search, "instal")).toEqual(["a"]);
        expect(await ids(search, "run instal")).toEqual(["a"]);
      },
    },
    {
      name: "an empty or whitespace-only query returns no hits",
      async check(search) {
        await search.index(COLLECTION, [doc("a", "Guide", "Some text.")]);
        expect(await ids(search, "")).toEqual([]);
        expect(await ids(search, "   \n\t")).toEqual([]);
      },
    },
    {
      name: "query syntax characters are treated as text, never as an error",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", 'Quote the value: say "hello" (twice).'),
        ]);
        for (const text of [
          '"',
          '"hello',
          "hello*",
          "(hello",
          "hello)",
          "title:hello",
          "hello AND",
          "OR hello",
          "NOT",
          "NEAR(hello",
          "hello & | ! :*",
          "'hello'",
          "-hello",
          "^hello",
          "{hello}",
          "*",
          "\\",
        ]) {
          const hits = await search.query(COLLECTION, {
            text,
            spaceIds: [SPACE],
          });
          expect(Array.isArray(hits)).toBe(true);
        }
        expect(await ids(search, '"hello')).toEqual(["a"]);
        expect(await ids(search, "(twice)")).toEqual(["a"]);
      },
    },
    {
      name: "indexing a document with the same key replaces it",
      async check(search) {
        await search.index(COLLECTION, [doc("a", "Old title", "old words")]);
        await search.index(COLLECTION, [
          doc("a", "New title", "fresh words", { revision: "r2" }),
        ]);
        expect(await ids(search, "old")).toEqual([]);
        const hits = await search.query(COLLECTION, {
          text: "words",
          spaceIds: [SPACE],
        });
        expect(hits.map((hit) => [hit.entryId, hit.revision])).toEqual([
          ["a", "r2"],
        ]);
      },
    },
    {
      name: "the same entry in two spaces is two documents",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "shared word"),
          doc("a", "Guide", "shared word", { spaceId: OTHER_SPACE }),
        ]);
        const hits = await search.query(COLLECTION, {
          text: "shared",
          spaceIds: [SPACE, OTHER_SPACE],
        });
        expect(hits.map((hit) => hit.spaceId).toSorted()).toEqual([
          SPACE,
          OTHER_SPACE,
        ]);
      },
    },
    {
      name: "only documents of the requested spaces are returned",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "common"),
          doc("b", "Guide", "common", { spaceId: OTHER_SPACE }),
        ]);
        expect(
          await ids(search, "common", { spaceIds: [OTHER_SPACE] }),
        ).toEqual(["b"]);
        expect(await ids(search, "common", { spaceIds: [] })).toEqual([]);
      },
    },
    {
      name: "collections are independent of each other",
      async check(search) {
        await search.index("site:one", [doc("a", "Guide", "alpha")]);
        await search.index("site:two", [doc("b", "Guide", "beta")]);
        expect(await ids(search, "alpha", { collection: "site:two" })).toEqual(
          [],
        );
        expect(await ids(search, "alpha", { collection: COLLECTION })).toEqual(
          [],
        );
        await search.clear("site:one");
        expect(await ids(search, "beta", { collection: "site:two" })).toEqual([
          "b",
        ]);
      },
    },
    {
      name: "remove with entry ids removes only those entries of the space",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "word"),
          doc("b", "Guide", "word"),
          doc("a", "Guide", "word", { spaceId: OTHER_SPACE }),
        ]);
        await search.remove(COLLECTION, SPACE, ["a"]);
        expect(await ids(search, "word")).toEqual(["b"]);
        expect(await ids(search, "word", { spaceIds: [OTHER_SPACE] })).toEqual([
          "a",
        ]);
      },
    },
    {
      name: "remove without entry ids removes the whole space",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "word"),
          doc("b", "Guide", "word"),
          doc("c", "Guide", "word", { spaceId: OTHER_SPACE }),
        ]);
        await search.index("other", [doc("d", "Guide", "word")]);
        await search.remove(COLLECTION, SPACE);
        expect(await ids(search, "word")).toEqual([]);
        expect(await ids(search, "word", { spaceIds: [OTHER_SPACE] })).toEqual([
          "c",
        ]);
        expect(await ids(search, "word", { collection: "other" })).toEqual([
          "d",
        ]);
      },
    },
    {
      name: "clear removes every document of the collection",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "word"),
          doc("b", "Guide", "word", { spaceId: OTHER_SPACE }),
        ]);
        await search.clear(COLLECTION);
        expect(
          await ids(search, "word", { spaceIds: [SPACE, OTHER_SPACE] }),
        ).toEqual([]);
      },
    },
    {
      name: "removing or clearing what is not there is a no-op",
      async check(search) {
        await search.index(COLLECTION, []);
        await search.remove(COLLECTION, SPACE, ["missing"]);
        await search.remove("missing", SPACE);
        await search.clear("missing");
        expect(await ids(search, "anything")).toEqual([]);
      },
    },
    {
      name: "hits carry the indexed fields and path, and omit a missing path",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "located here", {
            revision: "r7",
            path: "/guide/",
          }),
          doc("b", "Other", "located there"),
        ]);
        const hits = await search.query(COLLECTION, {
          text: "located",
          spaceIds: [SPACE],
        });
        const byId = new Map(hits.map((hit) => [hit.entryId, hit]));
        expect(byId.get("a")).toMatchObject({
          spaceId: SPACE,
          entryId: "a",
          revision: "r7",
          title: "Guide",
          path: "/guide/",
        });
        expect(byId.get("b")?.title).toBe("Other");
        expect(byId.get("b")?.path).toBeUndefined();
      },
    },
    {
      name: "the snippet is plain text from the document around the match",
      async check(search) {
        const text = `${"filler ".repeat(60)}the needle sits here. ${"more ".repeat(60)}`;
        await search.index(COLLECTION, [doc("a", "Guide", text)]);
        const [hit] = await search.query(COLLECTION, {
          text: "needle",
          spaceIds: [SPACE],
        });
        expect(hit?.snippet).toContain("needle");
        expect(hit?.snippet).not.toMatch(/[<>]/);
        expect(hit?.snippet.length).toBeLessThan(text.length);
      },
    },
    {
      name: "a snippet keeps markup-like text as text",
      async check(search) {
        await search.index(COLLECTION, [
          doc("a", "Guide", "Write <script>alert(1)</script> to inject."),
        ]);
        const [hit] = await search.query(COLLECTION, {
          text: "inject",
          spaceIds: [SPACE],
        });
        expect(hit?.snippet).toContain("<script>");
        expect(hit?.snippet).not.toContain("&lt;");
      },
    },
    {
      name: "hits come best first, by descending score",
      async check(search) {
        await search.index(COLLECTION, [
          doc("body", "Overview", "It mentions widgets once."),
          doc("title", "Widgets", "All about them."),
        ]);
        const hits = await search.query(COLLECTION, {
          text: "widgets",
          spaceIds: [SPACE],
        });
        expect(hits.map((hit) => hit.entryId)).toEqual(["title", "body"]);
        const scores = hits.map((hit) => hit.score);
        expect(scores).toEqual(scores.toSorted((a, b) => b - a));
      },
    },
    {
      name: "results are limited to 20 by default and to 100 at most",
      async check(search) {
        const documents = Array.from({ length: 120 }, (_, n) =>
          doc(`e${n}`, `Page ${n}`, "repeated term"),
        );
        await search.index(COLLECTION, documents);
        const query = { text: "repeated", spaceIds: [SPACE] };
        expect(await search.query(COLLECTION, query)).toHaveLength(20);
        expect(
          await search.query(COLLECTION, { ...query, limit: 5 }),
        ).toHaveLength(5);
        expect(
          await search.query(COLLECTION, { ...query, limit: 500 }),
        ).toHaveLength(100);
      },
    },
  ],
);
