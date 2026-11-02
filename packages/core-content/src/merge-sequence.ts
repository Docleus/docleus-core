import {
  compareStrings,
  longestCommonSubsequence,
  necessarilyMoved,
  otherSide,
  SIDES,
  type Side,
} from "./merge-values.ts";

export interface SequenceInput {
  /** The items that end up in the sequence. */
  readonly members: ReadonlySet<string>;
  readonly base: readonly string[];
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
  /** Both sides moved an item to different places; returns the side whose place it takes. */
  readonly moved: (item: string) => Side;
  /** Reorders of these items contradict each other; returns the side whose order they keep. */
  readonly contradicted: (items: readonly string[]) => Side;
}

const START = "";

/**
 * Orders merged siblings.
 *
 * Items the base sequence has are ordered pair by pair: a pair keeps its
 * base order unless one side swapped it (a side that lacks one of the two
 * counts as unchanged). When the merged pairs are not a consistent order,
 * the items involved go to `contradicted`.
 *
 * An item both sides certainly moved (it is on no longest common
 * subsequence with the base on either side) to places with different
 * unmoved predecessors goes to `moved` and is placed like a new item.
 *
 * Every other item is new here (inserted or moved in). It goes right after
 * the nearest ordered base item before it on the side that has it. Items
 * new at the same spot on both sides are interleaved independently of
 * which side is `ours`. An item both sides put here goes to `moved` unless
 * both put it after the same items.
 */
export function mergeSequence(input: SequenceInput): string[] {
  const keep = (list: readonly string[]): string[] =>
    list.filter((item) => input.members.has(item));
  const base = keep(input.base);
  const lists: Record<Side, string[]> = {
    ours: keep(input.ours),
    theirs: keep(input.theirs),
  };
  const indexes = {
    base: indexOf(base),
    ours: indexOf(lists.ours),
    theirs: indexOf(lists.theirs),
  };

  const isShared = (item: string): boolean =>
    indexes.ours.has(item) && indexes.theirs.has(item);
  const movedBy = {
    ours: necessarilyMoved(base, lists.ours),
    theirs: necessarilyMoved(base, lists.theirs),
  };
  const isStable = (item: string): boolean =>
    indexes.base.has(item) &&
    isShared(item) &&
    !movedBy.ours.has(item) &&
    !movedBy.theirs.has(item);
  const isContested = (item: string): boolean =>
    movedBy.ours.has(item) &&
    movedBy.theirs.has(item) &&
    nearestBefore("ours", item, isStable) !==
      nearestBefore("theirs", item, isStable);
  const contested = new Set(base.filter(isContested));
  const hard = orderBaseItems(
    base.filter((item) => !contested.has(item)),
    indexes,
    input.contradicted,
  );
  const isHard = new Set(hard);
  function nearestBefore(
    side: Side,
    item: string,
    matches: (other: string) => boolean,
  ): string {
    const list = lists[side];
    for (let at = (indexes[side].get(item) ?? 0) - 1; at >= 0; at -= 1) {
      const previous = list[at];
      if (previous !== undefined && matches(previous)) return previous;
    }
    return START;
  }
  const anchorIn = (side: Side, item: string): string =>
    nearestBefore(side, item, (other) => isHard.has(other));

  const placed = new Map<string, { anchor: string; sides: Side[] }>();
  const orphans: string[] = [];
  for (const item of [...input.members].toSorted(compareStrings)) {
    if (isHard.has(item)) continue;
    const sides = SIDES.filter((side) => indexes[side].has(item));
    const [first, second] = sides;
    if (first === undefined) {
      orphans.push(item);
    } else if (
      second === undefined ||
      (!contested.has(item) &&
        anchorIn(first, item) === anchorIn(second, item) &&
        nearestBefore(first, item, isShared) ===
          nearestBefore(second, item, isShared))
    ) {
      placed.set(item, { anchor: anchorIn(first, item), sides });
    } else {
      const side = input.moved(item);
      placed.set(item, { anchor: anchorIn(side, item), sides: [side] });
    }
  }

  const gap = (anchor: string): string[] => {
    const run = (side: Side): string[] =>
      lists[side].filter((item) => {
        const place = placed.get(item);
        return place?.anchor === anchor && place.sides.includes(side);
      });
    return interleave(run("ours"), run("theirs"));
  };
  return [
    ...gap(START),
    ...hard.flatMap((item) => [item, ...gap(item)]),
    ...orphans,
  ];
}

function indexOf(list: readonly string[]): Map<string, number> {
  return new Map(list.map((item, index) => [item, index]));
}

/**
 * The merged pairs form a tournament, so sorting by how many items each
 * one precedes gives the order where it is consistent, and the strongly
 * connected parts are the stretches where a prefix of that sort is not
 * closed under "precedes" (Landau's condition).
 */
function orderBaseItems(
  base: readonly string[],
  indexes: Readonly<Record<"base" | Side, ReadonlyMap<string, number>>>,
  contradicted: (items: readonly string[]) => Side,
): string[] {
  const precedes = (x: string, y: string): boolean => {
    const inBase = (indexes.base.get(x) ?? 0) < (indexes.base.get(y) ?? 0);
    const on = (side: Side): boolean => {
      const ix = indexes[side].get(x);
      const iy = indexes[side].get(y);
      return ix === undefined || iy === undefined ? inBase : ix < iy;
    };
    const ours = on("ours");
    const theirs = on("theirs");
    return ours === inBase ? theirs : ours;
  };
  const scores = new Map<string, number>();
  for (const x of base) {
    let score = 0;
    for (const y of base) if (x !== y && precedes(x, y)) score += 1;
    scores.set(x, score);
  }
  const sorted = base.toSorted(
    (a, b) =>
      (scores.get(b) ?? 0) - (scores.get(a) ?? 0) ||
      (indexes.base.get(a) ?? 0) - (indexes.base.get(b) ?? 0),
  );
  const n = sorted.length;
  const result: string[] = [];
  let start = 0;
  let sum = 0;
  sorted.forEach((item, index) => {
    sum += scores.get(item) ?? 0;
    const k = index + 1;
    if (sum !== (k * (k - 1)) / 2 + k * (n - k)) return;
    const part = sorted.slice(start, k);
    start = k;
    if (part.length === 1) {
      result.push(...part);
      return;
    }
    const side = contradicted(part.toSorted(compareStrings));
    const other = otherSide(side);
    const rank = (member: string): number =>
      indexes[side].get(member) ??
      n + (indexes[other].get(member) ?? indexes.base.get(member) ?? 0);
    result.push(
      ...part.toSorted((a, b) => rank(a) - rank(b) || compareStrings(a, b)),
    );
  });
  return result;
}

/** Merges two runs without a base, keeping each run's order where it can. */
function interleave(a: readonly string[], b: readonly string[]): string[] {
  const [left, right] =
    compareStrings(a.join("\u0000"), b.join("\u0000")) <= 0 ? [a, b] : [b, a];
  const shared = longestCommonSubsequence(left, right);
  const result: string[] = [];
  const emitted = new Set<string>();
  const push = (items: readonly string[]): void => {
    for (const item of items) {
      if (!emitted.has(item)) {
        emitted.add(item);
        result.push(item);
      }
    }
  };
  const pushRuns = (one: readonly string[], two: readonly string[]): void => {
    const firstOne = one.find((item) => !emitted.has(item));
    const firstTwo = two.find((item) => !emitted.has(item));
    if (
      firstOne !== undefined &&
      firstTwo !== undefined &&
      compareStrings(firstTwo, firstOne) < 0
    ) {
      push(two);
      push(one);
    } else {
      push(one);
      push(two);
    }
  };
  let i = 0;
  let j = 0;
  for (const item of shared) {
    const nextLeft = left.indexOf(item, i);
    const nextRight = right.indexOf(item, j);
    pushRuns(left.slice(i, nextLeft), right.slice(j, nextRight));
    push([item]);
    i = nextLeft + 1;
    j = nextRight + 1;
  }
  pushRuns(left.slice(i), right.slice(j));
  return result;
}
