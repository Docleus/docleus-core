import { describe, expect, it } from "vitest";

export interface Invariant<T> {
  readonly name: string;
  check(subject: T): Promise<void> | void;
}

export interface ConformanceSuite<T> {
  readonly name: string;
  readonly invariants: readonly Invariant<T>[];
}

/**
 * Defines a conformance suite: one `it` per invariant, run against whatever
 * `create()` returns. A replacement implementation that violates an
 * invariant must fail the matching test; `check` should throw or let a
 * failing `expect` propagate, not return a boolean.
 */
export function defineConformanceSuite<T>(
  name: string,
  invariants: readonly Invariant<T>[],
): ConformanceSuite<T> {
  return { name, invariants };
}

/** Checks one invariant against a fresh subject, disposing it whether or not the check passes. */
export async function checkInvariant<T>(
  invariant: Invariant<T>,
  create: () => Promise<T> | T,
  dispose?: (subject: T) => Promise<void> | void,
): Promise<void> {
  const subject = await create();
  try {
    await invariant.check(subject);
  } finally {
    await dispose?.(subject);
  }
}

export function runConformanceSuite<T>(
  suite: ConformanceSuite<T>,
  create: () => Promise<T> | T,
  dispose?: (subject: T) => Promise<void> | void,
): void {
  describe(suite.name, () => {
    for (const invariant of suite.invariants) {
      it(invariant.name, () => checkInvariant(invariant, create, dispose));
    }
  });
}

/** Asserts `fn()` throws or rejects, for an invariant phrased as "must reject ...". */
export async function expectToReject(fn: () => unknown): Promise<void> {
  await expect(Promise.resolve().then(fn)).rejects.toThrow();
}
