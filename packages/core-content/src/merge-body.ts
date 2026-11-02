import { DocleusError } from "@docleus/kernel";
import type { BlockNode, BlockPosition, MergeConflict } from "@docleus/sdk";
import { repairTree, type TreeProblem } from "./merge-repair.ts";
import { readBlockValue, type ConflictSink } from "./merge-resolution.ts";
import { mergeSequence } from "./merge-sequence.ts";
import {
  canonical,
  compareStrings,
  conflictDigest,
  necessarilyMoved,
  otherSide,
  SIDES,
  threeWay,
  type Side,
} from "./merge-values.ts";

type OwnBlock = Omit<BlockNode, "content">;

/** The root's key; block ids are never empty. */
const ROOT = "";

interface FlatBlock {
  readonly own: OwnBlock;
  readonly ownKey: string;
  readonly parent: string | undefined;
  readonly contentState: ContentState;
}

/** Whether a block carries `content`, kept apart so that `[]` and no `content` survive a merge. */
type ContentState = "absent" | "empty" | "filled";

interface FlatBody {
  readonly blocks: ReadonlyMap<string, FlatBlock>;
  readonly children: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_BODY: FlatBody = { blocks: new Map(), children: new Map() };

function flatten(body: BlockNode | undefined, entryId: string): FlatBody {
  if (!body) return EMPTY_BODY;
  const blocks = new Map<string, FlatBlock>();
  const children = new Map<string, string[]>();
  const ids = new Set<string>();
  const visit = (node: BlockNode, key: string, parent?: string): void => {
    if (ids.has(node.id)) {
      throw new DocleusError(
        "content/invalid-merge-input",
        `entry "${entryId}" has more than one block with id "${node.id}"`,
      );
    }
    ids.add(node.id);
    const { content, ...own } = node;
    blocks.set(key, {
      own,
      ownKey: canonical(own),
      parent,
      contentState:
        content === undefined
          ? "absent"
          : content.length === 0
            ? "empty"
            : "filled",
    });
    const keys = (content ?? []).map((child) => child.id);
    children.set(key, keys);
    for (const child of content ?? []) visit(child, child.id, key);
  };
  visit(body, ROOT);
  return { blocks, children };
}

interface SideAnalysis {
  readonly flat: FlatBody;
  /** Blocks this side added, moved to another parent or reordered. */
  readonly placed: ReadonlySet<string>;
  /** Blocks this side changed, or changed anything below. */
  readonly touched: ReadonlySet<string>;
}

function analyze(base: FlatBody, flat: FlatBody): SideAnalysis {
  const placed = new Set<string>();
  for (const [parent, keys] of flat.children) {
    const moved = necessarilyMoved(base.children.get(parent) ?? [], keys);
    for (const key of keys) {
      const before = base.blocks.get(key);
      if (!before || before.parent !== parent || moved.has(key)) {
        placed.add(key);
      }
    }
  }
  const touched = new Set<string>();
  const visit = (key: string): boolean => {
    let isTouched =
      placed.has(key) ||
      base.blocks.get(key)?.ownKey !== flat.blocks.get(key)?.ownKey;
    for (const child of flat.children.get(key) ?? []) {
      if (visit(child)) isTouched = true;
    }
    if (isTouched) touched.add(key);
    return isTouched;
  };
  if (flat.blocks.has(ROOT)) visit(ROOT);
  return { flat, placed, touched };
}

interface MergedBlock {
  readonly own: OwnBlock;
  /** `undefined` when the sides disagree. */
  readonly contentState: ContentState | undefined;
  readonly hadContent: boolean;
  readonly parent: string | undefined;
}

export interface BodyMergeInput {
  readonly entryId: string;
  readonly base: BlockNode | undefined;
  readonly ours: BlockNode | undefined;
  readonly theirs: BlockNode | undefined;
  readonly sink: ConflictSink;
}

/** Merges two changed bodies per block id; `undefined` when the body goes away. */
export function mergeBodies(input: BodyMergeInput): BlockNode | undefined {
  const { entryId, sink } = input;
  const base = flatten(input.base, entryId);
  const sides: Record<Side, SideAnalysis> = {
    ours: analyze(base, flatten(input.ours, entryId)),
    theirs: analyze(base, flatten(input.theirs, entryId)),
  };
  const flatOf = (side: Side | "base"): FlatBody =>
    side === "base" ? base : sides[side].flat;

  const rootId = (): string => {
    const id = base.blocks.get(ROOT)?.own.id;
    if (id !== undefined) return id;
    const ids = SIDES.flatMap((side) => {
      const own = sides[side].flat.blocks.get(ROOT)?.own;
      return own ? [own.id] : [];
    });
    return ids.toSorted(compareStrings)[0] ?? ROOT;
  };
  const blockIdOf = (key: string): string => (key === ROOT ? rootId() : key);

  const positionIn = (
    side: Side | "base",
    key: string,
  ): BlockPosition | undefined => {
    const flat = flatOf(side);
    const parent = flat.blocks.get(key)?.parent;
    if (parent === undefined) return undefined;
    const siblings = flat.children.get(parent) ?? [];
    const index = siblings.indexOf(key);
    return {
      parent:
        parent === ROOT ? (flat.blocks.get(ROOT)?.own.id ?? ROOT) : parent,
      after: index > 0 ? siblings[index - 1] : undefined,
    };
  };
  const positionConflict = (
    key: string,
  ): MergeConflict & { readonly kind: "block-position" } => {
    const positions = {
      base: positionIn("base", key),
      ours: positionIn("ours", key),
      theirs: positionIn("theirs", key),
    };
    const digest = conflictDigest(
      positions.base,
      positions.ours,
      positions.theirs,
    );
    return {
      id: `block-position:${entryId}:${key}:${digest}`,
      kind: "block-position",
      entryId,
      blockId: key,
      ...positions,
    };
  };

  const keys = new Set<string>([
    ...base.blocks.keys(),
    ...sides.ours.flat.blocks.keys(),
    ...sides.theirs.flat.blocks.keys(),
  ]);
  const merged = new Map<string, MergedBlock>();
  for (const key of [...keys].toSorted(compareStrings)) {
    const own = mergeOwn(key);
    if (!own) continue;
    merged.set(key, { ...own, ...mergePosition(key) });
  }
  if (!merged.has(ROOT)) return undefined;

  repairTree(merged, {
    placeAs(side, key, node) {
      const parent = sides[side].flat.blocks.get(key)?.parent;
      if (parent === undefined) return undefined;
      return { ...node, parent };
    },
    deletedBy(key) {
      const hasOurs = sides.ours.flat.blocks.has(key);
      if (hasOurs === sides.theirs.flat.blocks.has(key)) return undefined;
      return hasOurs ? "theirs" : "ours";
    },
    resolve(problem: TreeProblem) {
      const members = problem.kind === "dangling" ? [problem.id] : problem.ids;
      const decided = new Map<string, Side>();
      for (const key of members) {
        const conflict = positionConflict(key);
        const positions = [conflict.base, conflict.ours, conflict.theirs].map(
          canonical,
        );
        if (positions.every((position) => position === positions[0])) {
          continue;
        }
        const decision = sink.decide(conflict);
        decided.set(key, decision.side ?? sink.fallback);
      }
      return (key) => decided.get(key) ?? sink.fallback;
    },
  });

  const membersOf = new Map<string, Set<string>>();
  for (const [key, block] of merged) {
    if (block.parent === undefined) continue;
    const members = membersOf.get(block.parent) ?? new Set<string>();
    members.add(key);
    membersOf.set(block.parent, members);
  }
  const build = (key: string): BlockNode | undefined => {
    const block = merged.get(key);
    if (!block) return undefined;
    const members = membersOf.get(key);
    const order = members
      ? mergeSequence({
          members,
          base: base.children.get(key) ?? [],
          ours: sides.ours.flat.children.get(key) ?? [],
          theirs: sides.theirs.flat.children.get(key) ?? [],
          moved: (child) => decidePosition([child]),
          contradicted: (children) => decidePosition(children),
        })
      : [];
    const content = order.flatMap((child) => {
      const node = build(child);
      return node ? [node] : [];
    });
    const isEmptyKept =
      block.contentState === "empty" ||
      (block.contentState !== "absent" && block.hadContent);
    return content.length > 0 || isEmptyKept
      ? { ...block.own, content }
      : { ...block.own };
  };
  return build(ROOT);

  function mergeOwn(
    key: string,
  ): Pick<MergedBlock, "own" | "contentState" | "hadContent"> | undefined {
    const before = base.blocks.get(key);
    const versions: Record<Side, FlatBlock | undefined> = {
      ours: sides.ours.flat.blocks.get(key),
      theirs: sides.theirs.flat.blocks.get(key),
    };
    const content = {
      contentState: mergeContentState(
        before?.contentState,
        versions.ours?.contentState,
        versions.theirs?.contentState,
      ),
      hadContent: before !== undefined && before.contentState !== "absent",
    };
    const keep = (block: FlatBlock | undefined) =>
      block ? { own: block.own, ...content } : undefined;
    const ownKeys = {
      base: before?.ownKey,
      ours: versions.ours?.ownKey,
      theirs: versions.theirs?.ownKey,
    };
    if (ownKeys.ours === ownKeys.theirs) return keep(versions.ours);
    if (before) {
      for (const side of SIDES) {
        const other = otherSide(side);
        const isUnchanged = ownKeys[side] === ownKeys.base;
        const isDeletedByOther = versions[other] === undefined;
        if (
          isUnchanged &&
          !(isDeletedByOther && sides[side].touched.has(key))
        ) {
          return keep(versions[other]);
        }
      }
    } else {
      if (!versions.ours) return keep(versions.theirs);
      if (!versions.theirs) return keep(versions.ours);
    }
    const blockId = blockIdOf(key);
    const values = {
      base: before?.own,
      ours: versions.ours?.own,
      theirs: versions.theirs?.own,
    };
    const conflict: MergeConflict & { readonly kind: "block" } = {
      id: `block:${entryId}:${blockId}:${conflictDigest(values.base, values.ours, values.theirs)}`,
      kind: "block",
      entryId,
      blockId,
      ...values,
    };
    const decision = sink.decide(conflict);
    if (decision.side !== undefined) return keep(versions[decision.side]);
    const own = readBlockValue(conflict, decision.value, key !== ROOT);
    return own ? { own, ...content } : undefined;
  }

  function mergePosition(key: string): Pick<MergedBlock, "parent"> {
    if (key === ROOT) return { parent: undefined };
    const parentIn = (side: Side | "base") =>
      flatOf(side).blocks.get(key)?.parent;
    const isPlaced = (side: Side) =>
      sides[side].placed.has(key) && parentIn(side) !== undefined;
    const placedBy = SIDES.filter(isPlaced);
    const [only] = placedBy;
    if (placedBy.length === 2 && parentIn("ours") !== parentIn("theirs")) {
      const side = decidePosition([key]);
      const chosen = parentIn(side) === undefined ? otherSide(side) : side;
      return { parent: parentIn(chosen) };
    }
    if (only !== undefined) return { parent: parentIn(only) };
    return {
      parent: parentIn("base") ?? parentIn("ours") ?? parentIn("theirs"),
    };
  }

  /**
   * Reports a position conflict for each of `blockKeys` whose position differs
   * between the sides (all of them when none does) and settles them
   * together with the first one's decision.
   */
  function decidePosition(blockKeys: readonly string[]): Side {
    const conflicts = blockKeys.map(positionConflict);
    const differing = conflicts.filter(
      (conflict) => canonical(conflict.ours) !== canonical(conflict.theirs),
    );
    const decisions = (differing.length > 0 ? differing : conflicts).map(
      (conflict) => sink.decide(conflict).side ?? sink.fallback,
    );
    return decisions[0] ?? sink.fallback;
  }
}

function mergeContentState(
  base: ContentState | undefined,
  ours: ContentState | undefined,
  theirs: ContentState | undefined,
): ContentState | undefined {
  const left = ours ?? theirs;
  const right = theirs ?? ours;
  const merged = threeWay(base, left, right);
  return merged.isConflict ? undefined : merged.value;
}
