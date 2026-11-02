import type {
  BlockNode,
  EntryContent,
  EntrySet,
  MergeConflict,
  MergeInput,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { mergeEntrySets } from "./merge.ts";

function para(id: string, text: string, content?: BlockNode[]): BlockNode {
  return {
    id,
    type: "paragraph",
    v: 1,
    attrs: {},
    inline: [{ type: "text", text }],
    ...(content && { content }),
  };
}

function doc(...content: BlockNode[]): BlockNode {
  return { id: "root", type: "doc", v: 1, attrs: {}, content };
}

function page(
  title: string,
  body: BlockNode,
  parent?: string,
  order = 0,
): EntryContent {
  return { type: "page", title, parent, order, fields: {}, body };
}

function texts(node: BlockNode | undefined): string[] {
  if (!node) return [];
  const own = node.inline?.map((inline) => inline.text ?? "").join("") ?? "";
  return [
    ...(node.type === "doc" ? [] : [`${node.id}=${own}`]),
    ...(node.content ?? []).flatMap(texts),
  ];
}

function merge(input: MergeInput) {
  return mergeEntrySets(input);
}

function kinds(conflicts: readonly MergeConflict[]): string[] {
  return conflicts.map((conflict) => conflict.kind);
}

const base: EntrySet = {
  p: page("P", doc(para("a", "A"), para("b", "B"), para("c", "C"))),
};

function withAttrs(attrs: Record<string, unknown>): EntrySet {
  return {
    p: page(
      "P",
      doc({ ...para("a", "A"), attrs }, para("b", "B"), para("c", "C")),
    ),
  };
}

describe("mergeEntrySets: blocks", () => {
  it("merges changes to different blocks", () => {
    const result = merge({
      base,
      ours: {
        p: page("P", doc(para("a", "A1"), para("b", "B"), para("c", "C"))),
      },
      theirs: {
        p: page("P", doc(para("a", "A"), para("b", "B"), para("c", "C2"))),
      },
    });
    expect(result.conflicts).toEqual([]);
    expect(texts(result.entries.p?.body)).toEqual(["a=A1", "b=B", "c=C2"]);
  });

  it("reports a conflict when both change the same block, keeping ours", () => {
    const input: MergeInput = {
      base,
      ours: {
        p: page("P", doc(para("a", "ours"), para("b", "B"), para("c", "C"))),
      },
      theirs: {
        p: page("P", doc(para("a", "theirs"), para("b", "B"), para("c", "C"))),
      },
    };
    const result = merge(input);
    expect(texts(result.entries.p?.body)).toEqual(["a=ours", "b=B", "c=C"]);
    expect(result.conflicts).toHaveLength(1);
    const [conflict] = result.conflicts;
    expect(conflict).toMatchObject({
      kind: "block",
      entryId: "p",
      blockId: "a",
    });
    expect(conflict?.id).toMatch(/^block:p:a:/);
    expect(merge(input).conflicts[0]?.id).toBe(conflict?.id);

    const resolved = merge({
      ...input,
      resolutions: { [conflict?.id ?? ""]: { take: "theirs" } },
    });
    expect(resolved.conflicts).toEqual([]);
    expect(texts(resolved.entries.p?.body)).toEqual(["a=theirs", "b=B", "c=C"]);
  });

  it("does not conflict when both make the same change, regardless of key order", () => {
    const result = merge({
      base,
      ours: withAttrs({ x: 1, y: { m: 1, n: 2 } }),
      theirs: withAttrs({ y: { n: 2, m: 1 }, x: 1 }),
    });
    expect(result.conflicts).toEqual([]);
  });

  it("reports a conflict when one side deletes a block the other edits", () => {
    const input: MergeInput = {
      base,
      ours: { p: page("P", doc(para("a", "A"), para("c", "C"))) },
      theirs: {
        p: page("P", doc(para("a", "A"), para("b", "B2"), para("c", "C"))),
      },
    };
    const result = merge(input);
    expect(result.conflicts).toMatchObject([
      { kind: "block", blockId: "b", ours: undefined },
    ]);
    expect(texts(result.entries.p?.body)).toEqual(["a=A", "c=C"]);
    const id = result.conflicts[0]?.id ?? "";
    const kept = merge({ ...input, resolutions: { [id]: { take: "theirs" } } });
    expect(kept.conflicts).toEqual([]);
    expect(texts(kept.entries.p?.body)).toEqual(["a=A", "b=B2", "c=C"]);
  });

  it("reports a conflict when one side deletes a block whose child the other edits", () => {
    const nested: EntrySet = {
      p: page("P", doc(para("a", "A", [para("a1", "A1")]), para("b", "B"))),
    };
    const result = merge({
      base: nested,
      ours: { p: page("P", doc(para("b", "B"))) },
      theirs: {
        p: page(
          "P",
          doc(para("a", "A", [para("a1", "changed")]), para("b", "B")),
        ),
      },
    });
    expect(result.conflicts).toMatchObject([
      { kind: "block", blockId: "a1", ours: undefined },
      { kind: "block", blockId: "a", ours: undefined },
    ]);
    expect(texts(result.entries.p?.body)).toEqual(["b=B"]);
  });

  it("removes descendants with a clean delete", () => {
    const nested: EntrySet = {
      p: page("P", doc(para("a", "A", [para("a1", "A1")]), para("b", "B"))),
    };
    const result = merge({
      base: nested,
      ours: { p: page("P", doc(para("b", "B"))) },
      theirs: {
        p: page("P", doc(para("a", "A", [para("a1", "A1")]), para("b", "B2"))),
      },
    });
    expect(result.conflicts).toEqual([]);
    expect(texts(result.entries.p?.body)).toEqual(["b=B2"]);
  });

  it("applies a move on one side and an edit of the same block on the other", () => {
    const result = merge({
      base,
      ours: {
        p: page("P", doc(para("b", "B"), para("c", "C", [para("a", "A")]))),
      },
      theirs: {
        p: page("P", doc(para("a", "A2"), para("b", "B"), para("c", "C"))),
      },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.entries.p?.body).toEqual(
      doc(para("b", "B"), para("c", "C", [para("a", "A2")])),
    );
  });

  it("keeps inserts from both sides and does not conflict on sibling order", () => {
    const result = merge({
      base,
      ours: {
        p: page(
          "P",
          doc(para("a", "A"), para("x", "X"), para("b", "B"), para("c", "C")),
        ),
      },
      theirs: {
        p: page(
          "P",
          doc(para("a", "A"), para("b", "B"), para("y", "Y"), para("c", "C")),
        ),
      },
    });
    expect(result.conflicts).toEqual([]);
    expect(texts(result.entries.p?.body)).toEqual([
      "a=A",
      "x=X",
      "b=B",
      "y=Y",
      "c=C",
    ]);
  });

  it("orders inserts at the same spot the same way whichever side is ours", () => {
    const ours: EntrySet = {
      p: page(
        "P",
        doc(para("a", "A"), para("y", "Y"), para("b", "B"), para("c", "C")),
      ),
    };
    const theirs: EntrySet = {
      p: page(
        "P",
        doc(para("a", "A"), para("x", "X"), para("b", "B"), para("c", "C")),
      ),
    };
    const one = merge({ base, ours, theirs });
    const other = merge({ base, ours: theirs, theirs: ours });
    expect(one.conflicts).toEqual([]);
    expect(texts(one.entries.p?.body)).toEqual([
      "a=A",
      "x=X",
      "y=Y",
      "b=B",
      "c=C",
    ]);
    expect(other.entries).toEqual(one.entries);
  });

  it("keeps a reorder on one side while the other inserts and deletes", () => {
    const result = merge({
      base,
      ours: {
        p: page("P", doc(para("c", "C"), para("a", "A"), para("b", "B"))),
      },
      theirs: {
        p: page("P", doc(para("a", "A"), para("n", "N"), para("c", "C"))),
      },
    });
    expect(result.conflicts).toEqual([]);
    expect(texts(result.entries.p?.body)).toEqual(["c=C", "a=A", "n=N"]);
  });

  it("reports conflicting moves of the same block", () => {
    const result = merge({
      base,
      ours: {
        p: page("P", doc(para("b", "B", [para("a", "A")]), para("c", "C"))),
      },
      theirs: {
        p: page("P", doc(para("b", "B"), para("c", "C", [para("a", "A")]))),
      },
    });
    expect(result.conflicts).toMatchObject([
      {
        kind: "block-position",
        blockId: "a",
        base: { parent: "root", after: undefined },
        ours: { parent: "b", after: undefined },
        theirs: { parent: "c", after: undefined },
      },
    ]);
    expect(result.entries.p?.body).toEqual(
      doc(para("b", "B", [para("a", "A")]), para("c", "C")),
    );
  });

  it("reports moves that would nest a block inside itself and keeps a valid tree", () => {
    const input: MergeInput = {
      base,
      ours: {
        p: page("P", doc(para("b", "B", [para("a", "A")]), para("c", "C"))),
      },
      theirs: {
        p: page("P", doc(para("a", "A", [para("b", "B")]), para("c", "C"))),
      },
    };
    const result = merge(input);
    expect(kinds(result.conflicts)).toEqual([
      "block-position",
      "block-position",
    ]);
    expect(texts(result.entries.p?.body).toSorted()).toEqual([
      "a=A",
      "b=B",
      "c=C",
    ]);
    const resolutions = Object.fromEntries(
      result.conflicts.map((conflict) => [
        conflict.id,
        { take: "theirs" as const },
      ]),
    );
    const resolved = merge({ ...input, resolutions });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.entries.p?.body).toEqual(input.theirs.p?.body);
  });

  it("accepts a block value as resolution", () => {
    const input: MergeInput = {
      base,
      ours: {
        p: page("P", doc(para("a", "ours"), para("b", "B"), para("c", "C"))),
      },
      theirs: {
        p: page("P", doc(para("a", "theirs"), para("b", "B"), para("c", "C"))),
      },
    };
    const id = merge(input).conflicts[0]?.id ?? "";
    const result = merge({
      ...input,
      resolutions: { [id]: { value: para("a", "both") } },
    });
    expect(result.conflicts).toEqual([]);
    expect(texts(result.entries.p?.body)).toEqual(["a=both", "b=B", "c=C"]);

    const deleted = merge({ ...input, resolutions: { [id]: { value: null } } });
    expect(texts(deleted.entries.p?.body)).toEqual(["b=B", "c=C"]);

    for (const value of [{ id: "a" }, { ...para("z", "Z") }, doc()]) {
      expect(() =>
        merge({ ...input, resolutions: { [id]: { value } } }),
      ).toThrow(
        expect.objectContaining({ code: "content/invalid-resolution" }),
      );
    }
  });
});

describe("mergeEntrySets: entries", () => {
  const tree: EntrySet = {
    a: page("A", doc()),
    b: page("B", doc(), "a", 0),
    c: page("C", doc(), undefined, 1),
  };
  const withFields = (fields: Record<string, unknown>): EntrySet => ({
    ...tree,
    c: { ...page("C", doc(), undefined, 1), fields },
  });

  it("reports a conflict when one side deletes an entry the other edits", () => {
    const input: MergeInput = {
      base: tree,
      ours: {
        a: tree.a ?? page("A", doc()),
        c: page("C", doc(), undefined, 1),
      },
      theirs: { ...tree, b: page("B2", doc(), "a", 0) },
    };
    const result = merge(input);
    expect(result.conflicts).toMatchObject([
      { kind: "entry-deleted", entryId: "b", ours: undefined },
    ]);
    expect(Object.keys(result.entries)).toEqual(["a", "c"]);
    const id = result.conflicts[0]?.id ?? "";
    const kept = merge({ ...input, resolutions: { [id]: { take: "theirs" } } });
    expect(kept.entries.b?.title).toBe("B2");
  });

  it("reports a conflict when one side deletes an entry the other adds a child to", () => {
    const result = merge({
      base: tree,
      ours: { c: page("C", doc(), undefined, 1) },
      theirs: { ...tree, d: page("D", doc(), "b", 0) },
    });
    expect(result.conflicts).toMatchObject([
      { kind: "entry-deleted", entryId: "a" },
      { kind: "entry-deleted", entryId: "b" },
    ]);
    expect(Object.keys(result.entries)).toEqual(["c"]);
  });

  it("removes descendant entries with a clean delete", () => {
    const result = merge({
      base: tree,
      ours: { c: page("C", doc(), undefined, 1) },
      theirs: { ...tree, c: page("C2", doc(), undefined, 1) },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.entries).toEqual({ c: page("C2", doc(), undefined, 1) });
  });

  it("applies a page move on one side and a rename on the other", () => {
    const result = merge({
      base: tree,
      ours: { ...tree, b: page("B", doc(), "c", 3) },
      theirs: { ...tree, b: page("Renamed", doc(), "a", 0) },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.entries.b).toEqual(page("Renamed", doc(), "c", 3));
  });

  it("keeps pages both sides add under the same parent", () => {
    const result = merge({
      base: tree,
      ours: { ...tree, x: page("X", doc(), "a", 1) },
      theirs: { ...tree, y: page("Y", doc(), "a", 1) },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.entries.x?.parent).toBe("a");
    expect(result.entries.y?.parent).toBe("a");
  });

  it("reports conflicting page moves and renames", () => {
    const result = merge({
      base: tree,
      ours: { ...tree, b: page("Ours", doc(), "c", 0) },
      theirs: { ...tree, b: page("Theirs", doc(), undefined, 5) },
    });
    expect(result.conflicts).toMatchObject([
      { kind: "entry", field: "position", ours: { parent: "c", order: 0 } },
      { kind: "entry", field: "title", ours: "Ours", theirs: "Theirs" },
    ]);
    expect(result.entries.b).toEqual(page("Ours", doc(), "c", 0));
  });

  it("merges fields per key and reports both-changed keys as one conflict", () => {
    const start = withFields({ k: 1, l: 1 });
    expect(
      merge({
        base: start,
        ours: withFields({ k: 2, l: 1 }),
        theirs: withFields({ k: 1, l: 3, m: 4 }),
      }).entries.c?.fields,
    ).toEqual({ k: 2, l: 3, m: 4 });
    const conflicting = merge({
      base: start,
      ours: withFields({ k: 2, l: 1 }),
      theirs: withFields({ k: 3, l: 4 }),
    });
    expect(conflicting.conflicts).toMatchObject([
      { kind: "entry", field: "fields", ours: { k: 2, l: 1 } },
    ]);
    expect(conflicting.entries.c?.fields).toEqual({ k: 2, l: 4 });
  });

  it("reports a cycle in the merged tree and keeps a valid tree", () => {
    const flat: EntrySet = {
      a: page("A", doc()),
      b: page("B", doc(), undefined, 1),
    };
    const input: MergeInput = {
      base: flat,
      ours: { ...flat, a: page("A", doc(), "b", 0) },
      theirs: { ...flat, b: page("B", doc(), "a", 0) },
    };
    const result = merge(input);
    expect(result.conflicts).toMatchObject([
      { kind: "tree", entryIds: ["a", "b"] },
    ]);
    expect(result.entries).toEqual(input.ours);
    const id = result.conflicts[0]?.id ?? "";
    const resolved = merge({
      ...input,
      resolutions: { [id]: { take: "theirs" } },
    });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.entries).toEqual(input.theirs);
  });

  it("accepts entry values as resolutions and rejects invalid ones", () => {
    const input: MergeInput = {
      base: tree,
      ours: { ...tree, c: page("Ours", doc(), undefined, 1) },
      theirs: { ...tree, c: page("Theirs", doc(), undefined, 1) },
    };
    const id = merge(input).conflicts[0]?.id ?? "";
    const result = merge({
      ...input,
      resolutions: { [id]: { value: "Both" } },
    });
    expect(result.conflicts).toEqual([]);
    expect(result.entries.c?.title).toBe("Both");
    expect(() =>
      merge({ ...input, resolutions: { [id]: { value: 42 } } }),
    ).toThrow(expect.objectContaining({ code: "content/invalid-resolution" }));
    expect(() =>
      merge({ ...input, resolutions: { [id]: { take: "mine" } as never } }),
    ).toThrow(expect.objectContaining({ code: "content/invalid-resolution" }));
  });

  it("ignores resolutions for conflicts that do not occur", () => {
    const result = merge({
      base: tree,
      ours: tree,
      theirs: tree,
      resolutions: { "block:x:y:z": { take: "theirs" } },
    });
    expect(result).toEqual({ entries: tree, conflicts: [] });
  });
});
