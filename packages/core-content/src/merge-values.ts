import { createHash } from "node:crypto";
import { stableStringify } from "./entry.ts";

export type Side = "ours" | "theirs";

export const SIDES: readonly Side[] = ["ours", "theirs"];

export function otherSide(side: Side): Side {
  return side === "ours" ? "theirs" : "ours";
}

/** Key-order independent; `undefined` members are ignored. */
export function canonical(value: unknown): string {
  return value === undefined ? "" : stableStringify(value);
}

export function isEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A short digest of what conflicts. `ours` and `theirs` are unordered so
 * that swapping the sides keeps the id.
 */
export function conflictDigest(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): string {
  const sides = [canonical(ours), canonical(theirs)].toSorted(compareStrings);
  return createHash("sha256")
    .update(JSON.stringify([canonical(base), ...sides]))
    .digest("hex")
    .slice(0, 12);
}

export type ThreeWay<T> =
  | { readonly isConflict: false; readonly value: T }
  | { readonly isConflict: true };

/** Takes the side that changed; reports a conflict when both changed differently. */
export function threeWay<T>(
  base: T | undefined,
  ours: T,
  theirs: T,
): ThreeWay<T> {
  if (isEqual(ours, theirs)) return { isConflict: false, value: ours };
  if (isEqual(ours, base)) return { isConflict: false, value: theirs };
  if (isEqual(theirs, base)) return { isConflict: false, value: ours };
  return { isConflict: true };
}

/** Longest common subsequence of two sequences of distinct strings. */
export function longestCommonSubsequence(
  a: readonly string[],
  b: readonly string[],
): string[] {
  const inB = new Set(b);
  const inA = new Set(a);
  const left = a.filter((item) => inB.has(item));
  const right = b.filter((item) => inA.has(item));
  let start = 0;
  while (
    start < left.length &&
    start < right.length &&
    left[start] === right[start]
  ) {
    start += 1;
  }
  let endLeft = left.length;
  let endRight = right.length;
  while (
    endLeft > start &&
    endRight > start &&
    left[endLeft - 1] === right[endRight - 1]
  ) {
    endLeft -= 1;
    endRight -= 1;
  }
  const middleLeft = left.slice(start, endLeft);
  const middleRight = right.slice(start, endRight);
  const width = middleRight.length + 1;
  const lengths = new Uint32Array((middleLeft.length + 1) * width);
  for (let i = middleLeft.length - 1; i >= 0; i -= 1) {
    for (let j = middleRight.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        middleLeft[i] === middleRight[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lengths[(i + 1) * width + j] ?? 0,
              lengths[i * width + j + 1] ?? 0,
            );
    }
  }
  const middle: string[] = [];
  let i = 0;
  let j = 0;
  while (i < middleLeft.length && j < middleRight.length) {
    const item = middleLeft[i];
    if (item !== undefined && item === middleRight[j]) {
      middle.push(item);
      i += 1;
      j += 1;
    } else if (
      (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)
    ) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return [...left.slice(0, start), ...middle, ...left.slice(endLeft)];
}

/**
 * The items of `side` that `base` also has but that lie on no longest
 * common subsequence with it: the ones that side certainly moved. When
 * two items swap, neither is certain, so neither counts as moved.
 */
export function necessarilyMoved(
  base: readonly string[],
  side: readonly string[],
): Set<string> {
  const position = new Map(base.map((item, index) => [item, index]));
  const sequence = side.filter((item) => position.has(item));
  const ranks = sequence.map((item) => position.get(item) ?? 0);
  const ending = ranks.map(() => 1);
  const starting = ranks.map(() => 1);
  ranks.forEach((rank, i) => {
    for (let j = 0; j < i; j += 1) {
      if ((ranks[j] ?? 0) < rank) {
        ending[i] = Math.max(ending[i] ?? 1, (ending[j] ?? 1) + 1);
      }
    }
  });
  for (let i = ranks.length - 1; i >= 0; i -= 1) {
    for (let j = i + 1; j < ranks.length; j += 1) {
      if ((ranks[j] ?? 0) > (ranks[i] ?? 0)) {
        starting[i] = Math.max(starting[i] ?? 1, (starting[j] ?? 1) + 1);
      }
    }
  }
  const longest = Math.max(0, ...ending);
  const result = new Set<string>();
  sequence.forEach((item, i) => {
    if ((ending[i] ?? 0) + (starting[i] ?? 0) - 1 < longest) result.add(item);
  });
  return result;
}
