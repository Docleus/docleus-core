import type {
  BlockNode,
  EntryContent,
  EntrySet,
  MergeConflict,
  MergeResolution,
} from "@docleus/sdk";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeEntrySets } from "./merge.ts";

interface ModelBlock {
  readonly id: string;
  text: string;
  attrs: Record<string, unknown>;
  children: ModelBlock[] | undefined;
}

interface ModelPage {
  title: string;
  parent: string | undefined;
  order: number;
  fields: Record<string, unknown>;
  root: ModelBlock;
}

type Model = Map<string, ModelPage>;

const TEXT = fc.constantFrom("x", "y", "z");
const VALUE = fc.constantFrom<unknown>(
  1,
  2,
  "s",
  { m: 1, n: 2 },
  { n: 2, m: 1 },
  [1, 2],
);
const KEY = fc.constantFrom("k", "l", "m");

const addPage = fc.record({
  kind: fc.constant("add-page" as const),
  parent: fc.nat(),
  order: fc.integer({ min: 0, max: 3 }),
  title: TEXT,
});
const insertBlock = fc.record({
  kind: fc.constant("insert" as const),
  page: fc.nat(),
  block: fc.nat(),
  at: fc.nat(),
  text: TEXT,
});

const op = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("text" as const),
      page: fc.nat(),
      block: fc.nat(),
      text: TEXT,
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("attr" as const),
      page: fc.nat(),
      block: fc.nat(),
      key: KEY,
      value: VALUE,
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("insert" as const),
      page: fc.nat(),
      block: fc.nat(),
      at: fc.nat(),
      text: TEXT,
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      page: fc.nat(),
      block: fc.nat(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      page: fc.nat(),
      block: fc.nat(),
      target: fc.nat(),
      at: fc.nat(),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("add-page" as const),
      parent: fc.nat(),
      order: fc.integer({ min: 0, max: 3 }),
      title: TEXT,
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("delete-page" as const),
      page: fc.nat(),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("rename-page" as const),
      page: fc.nat(),
      title: TEXT,
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("move-page" as const),
      page: fc.nat(),
      parent: fc.nat(),
      order: fc.integer({ min: 0, max: 3 }),
    }),
    weight: 3,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("field" as const),
      page: fc.nat(),
      key: KEY,
      value: VALUE,
    }),
    weight: 2,
  },
);

type Op = typeof op extends fc.Arbitrary<infer T> ? T : never;

const script = (maxLength: number) => fc.array(op, { maxLength });

/** Builds a base: mostly pages and nested blocks. */
const baseScript = fc
  .tuple(
    fc.array(addPage, { minLength: 1, maxLength: 4 }),
    fc.array(insertBlock, { minLength: 2, maxLength: 16 }),
    script(4),
  )
  .map(([pages, blocks, rest]) => [...pages, ...blocks, ...rest]);

function pick<T>(items: readonly T[], index: number): T | undefined {
  return items.length === 0 ? undefined : items[index % items.length];
}

function blocksOf(block: ModelBlock): ModelBlock[] {
  return [block, ...(block.children ?? []).flatMap(blocksOf)];
}

function parentOf(root: ModelBlock, id: string): ModelBlock | undefined {
  return blocksOf(root).find((block) =>
    block.children?.some((child) => child.id === id),
  );
}

function isAncestor(model: Model, ancestor: string, id: string): boolean {
  let current: string | undefined = id;
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = model.get(current)?.parent;
  }
  return false;
}

function apply(
  model: Model,
  ops: readonly Op[],
  prefix: string,
  canEdit: (pageId: string) => boolean = () => true,
): Model {
  let counter = 0;
  const pages = () => [...model.keys()].toSorted();
  for (const step of ops) {
    if (step.kind === "add-page") {
      const id = `${prefix}p${counter++}`;
      const parent = step.parent === 0 ? undefined : pick(pages(), step.parent);
      model.set(id, {
        title: step.title,
        parent,
        order: step.order,
        fields: {},
        root: { id: "root", text: "", attrs: {}, children: [] },
      });
      continue;
    }
    const pageId = pick(pages().filter(canEdit), step.page);
    const page = pageId === undefined ? undefined : model.get(pageId);
    if (pageId === undefined || !page) continue;
    const all = blocksOf(page.root);
    const nonRoot = all.slice(1);
    switch (step.kind) {
      case "text": {
        const block = pick(nonRoot, step.block);
        if (block) block.text = step.text;
        break;
      }
      case "attr": {
        const block = pick(nonRoot, step.block);
        if (block) block.attrs = { ...block.attrs, [step.key]: step.value };
        break;
      }
      case "insert": {
        const parent = pick(all, step.block);
        if (!parent) break;
        const children = parent.children ?? [];
        children.splice(step.at % (children.length + 1), 0, {
          id: `${prefix}${counter++}`,
          text: step.text,
          attrs: {},
          children: undefined,
        });
        parent.children = children;
        break;
      }
      case "delete": {
        const block = pick(nonRoot, step.block);
        const parent = block && parentOf(page.root, block.id);
        if (block && parent?.children) {
          parent.children = parent.children.filter((c) => c !== block);
        }
        break;
      }
      case "move": {
        const block = pick(nonRoot, step.block);
        const target = pick(all, step.target);
        if (!block || !target || blocksOf(block).includes(target)) break;
        const parent = parentOf(page.root, block.id);
        if (!parent?.children) break;
        parent.children = parent.children.filter((c) => c !== block);
        const children = target.children ?? [];
        children.splice(step.at % (children.length + 1), 0, block);
        target.children = children;
        break;
      }
      case "delete-page": {
        const doomed = pages().filter((id) => isAncestor(model, pageId, id));
        for (const id of doomed) model.delete(id);
        break;
      }
      case "rename-page":
        page.title = step.title;
        break;
      case "move-page": {
        const parent =
          step.parent === 0 ? undefined : pick(pages(), step.parent);
        if (parent !== undefined && isAncestor(model, pageId, parent)) break;
        page.parent = parent;
        page.order = step.order;
        break;
      }
      case "field":
        page.fields = { ...page.fields, [step.key]: step.value };
        break;
    }
  }
  return model;
}

function toBlock(block: ModelBlock, isRoot: boolean): BlockNode {
  const content = block.children?.map((child) => toBlock(child, false));
  return isRoot
    ? { id: block.id, type: "doc", v: 1, attrs: {}, content: content ?? [] }
    : {
        id: block.id,
        type: "paragraph",
        v: 1,
        attrs: block.attrs,
        inline: [{ type: "text", text: block.text }],
        ...(content && { content }),
      };
}

function toEntrySet(model: Model): EntrySet {
  const entries: Record<string, EntryContent> = {};
  for (const [id, page] of model) {
    entries[id] = {
      type: "page",
      title: page.title,
      parent: page.parent,
      order: page.order,
      fields: page.fields,
      body: toBlock(page.root, true),
    };
  }
  return entries;
}

function fromEntrySet(entries: EntrySet): Model {
  const model: Model = new Map();
  const fromBlock = (node: BlockNode): ModelBlock => ({
    id: node.id,
    text: node.inline?.[0]?.text ?? "",
    attrs: { ...node.attrs },
    children: node.content?.map(fromBlock),
  });
  for (const [id, entry] of Object.entries(entries)) {
    model.set(id, {
      title: entry.title,
      parent: entry.parent,
      order: entry.order,
      fields: { ...entry.fields },
      root: fromBlock(
        entry.body ?? { id: "root", type: "doc", v: 1, attrs: {} },
      ),
    });
  }
  return model;
}

/** Small indexes make both sides pick the same blocks and pages. */
const SMALL = fc.nat({ max: 3 });

const moveOp = fc.oneof(
  fc.record({
    kind: fc.constant("move" as const),
    page: SMALL,
    block: SMALL,
    target: SMALL,
    at: SMALL,
  }),
  fc.record({
    kind: fc.constant("move-page" as const),
    page: SMALL,
    parent: SMALL,
    order: fc.integer({ min: 0, max: 3 }),
  }),
);

/** Mostly moves, so that conflicting moves, cycles and reorders come up often. */
const moveScript = fc
  .tuple(fc.array(moveOp, { minLength: 1, maxLength: 4 }), script(2))
  .map(([moves, rest]) => [...moves, ...rest]);

const sideScript = fc.oneof(script(6), moveScript);

const scenario = fc
  .record({ base: baseScript, ours: sideScript, theirs: sideScript })
  .map(({ base: baseOps, ours: oursOps, theirs: theirsOps }) => {
    const base = toEntrySet(apply(new Map(), baseOps, "b"));
    return {
      base,
      ours: toEntrySet(apply(fromEntrySet(base), oursOps, "o")),
      theirs: toEntrySet(apply(fromEntrySet(base), theirsOps, "t")),
    };
  });

const DISJOINT_KINDS = new Set<Op["kind"]>([
  "text",
  "attr",
  "insert",
  "delete",
  "move",
  "add-page",
  "rename-page",
  "field",
]);
const disjointScript = script(6).map((ops) =>
  ops.filter((step) => DISJOINT_KINDS.has(step.kind)),
);

/** Ours edits only even-numbered base pages, theirs only odd ones; neither deletes or moves pages. */
const disjointScenario = fc
  .record({ base: baseScript, ours: disjointScript, theirs: disjointScript })
  .map(({ base: baseOps, ours: oursOps, theirs: theirsOps }) => {
    const base = toEntrySet(apply(new Map(), baseOps, "b"));
    const ids = Object.keys(base).toSorted();
    const isOurs = (id: string) => ids.indexOf(id) % 2 === 0;
    const isTheirs = (id: string) => ids.indexOf(id) % 2 === 1;
    return {
      base,
      ours: toEntrySet(apply(fromEntrySet(base), oursOps, "o", isOurs)),
      theirs: toEntrySet(apply(fromEntrySet(base), theirsOps, "t", isTheirs)),
    };
  });

function assertValid(entries: EntrySet): void {
  for (const [id, entry] of Object.entries(entries)) {
    const seen = new Set([id]);
    let parent = entry.parent;
    while (parent !== undefined) {
      expect(Object.hasOwn(entries, parent), `parent of ${id}`).toBe(true);
      expect(seen.has(parent), `cycle at ${id}`).toBe(false);
      seen.add(parent);
      parent = entries[parent]?.parent;
    }
    expect(entry.body?.type).toBe("doc");
    const ids: string[] = [];
    const visit = (node: BlockNode): void => {
      ids.push(node.id);
      node.content?.forEach(visit);
    };
    if (entry.body) visit(entry.body);
    expect(new Set(ids).size).toBe(ids.length);
  }
}

function takeAll(
  conflicts: readonly MergeConflict[],
  take: "ours" | "theirs",
): Record<string, MergeResolution> {
  return Object.fromEntries(conflicts.map((c) => [c.id, { take }]));
}

function swapped(conflict: MergeConflict): MergeConflict {
  switch (conflict.kind) {
    case "tree":
      return conflict;
    case "entry":
      return { ...conflict, ours: conflict.theirs, theirs: conflict.ours };
    case "entry-deleted":
      return { ...conflict, ours: conflict.theirs, theirs: conflict.ours };
    case "block":
      return { ...conflict, ours: conflict.theirs, theirs: conflict.ours };
    case "block-position":
      return { ...conflict, ours: conflict.theirs, theirs: conflict.ours };
  }
}

const RUNS = { numRuns: Number(process.env.MERGE_RUNS ?? 300) };

describe("mergeEntrySets properties", () => {
  it("takes the only side that changed", () => {
    fc.assert(
      fc.property(scenario, ({ base, ours, theirs }) => {
        expect(mergeEntrySets({ base, ours: base, theirs })).toEqual({
          entries: theirs,
          conflicts: [],
        });
        expect(mergeEntrySets({ base, ours, theirs: base })).toEqual({
          entries: ours,
          conflicts: [],
        });
      }),
      RUNS,
    );
  });

  it("takes the same change made on both sides", () => {
    fc.assert(
      fc.property(scenario, ({ base, ours }) => {
        expect(mergeEntrySets({ base, ours, theirs: ours })).toEqual({
          entries: ours,
          conflicts: [],
        });
      }),
      RUNS,
    );
  });

  it("reports the same conflicts with the sides swapped", () => {
    fc.assert(
      fc.property(scenario, ({ base, ours, theirs }) => {
        const one = mergeEntrySets({ base, ours, theirs });
        const other = mergeEntrySets({ base, ours: theirs, theirs: ours });
        expect(other.conflicts).toEqual(one.conflicts.map(swapped));
        if (one.conflicts.length === 0)
          expect(other.entries).toEqual(one.entries);
      }),
      RUNS,
    );
  });

  it("merges edits to disjoint pages cleanly, keeping both", () => {
    fc.assert(
      fc.property(disjointScenario, ({ base, ours, theirs }) => {
        const result = mergeEntrySets({ base, ours, theirs });
        expect(result.conflicts).toEqual([]);
        const expected: Record<string, EntryContent> = {};
        for (const set of [base, theirs, ours]) {
          for (const [id, entry] of Object.entries(set)) {
            const isChanged =
              set === base ||
              JSON.stringify(entry) !== JSON.stringify(base[id]);
            if (isChanged) expected[id] = entry;
          }
        }
        expect(result.entries).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("always returns a valid entry set", () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const result = mergeEntrySets(input);
        assertValid(result.entries);
        assertValid(
          mergeEntrySets({
            ...input,
            resolutions: takeAll(result.conflicts, "theirs"),
          }).entries,
        );
      }),
      RUNS,
    );
  });

  it("gives a clean result when every conflict takes one side", () => {
    fc.assert(
      fc.property(
        scenario,
        fc.constantFrom("ours" as const, "theirs" as const),
        (input, take) => {
          const { conflicts } = mergeEntrySets(input);
          const resolved = mergeEntrySets({
            ...input,
            resolutions: takeAll(conflicts, take),
          });
          expect(resolved.conflicts).toEqual([]);
        },
      ),
      RUNS,
    );
  });

  it("re-merging a clean result is a no-op", () => {
    fc.assert(
      fc.property(scenario, ({ base, ours, theirs }) => {
        const result = mergeEntrySets({ base, ours, theirs });
        fc.pre(result.conflicts.length === 0);
        expect(mergeEntrySets({ base, ours: result.entries, theirs })).toEqual(
          result,
        );
      }),
      RUNS,
    );
  });
});
