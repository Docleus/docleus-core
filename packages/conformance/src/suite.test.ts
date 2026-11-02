import { describe, expect, it, vi } from "vitest";
import {
  checkInvariant,
  defineConformanceSuite,
  runConformanceSuite,
} from "./suite.ts";

interface Counter {
  increment(): number;
}

const counterSuite = defineConformanceSuite<Counter>("Counter", [
  {
    name: "starts below 1 and increments by exactly 1",
    check(counter) {
      const first = counter.increment();
      const second = counter.increment();
      expect(second).toBe(first + 1);
    },
  },
  {
    name: "never returns a negative value",
    check(counter) {
      expect(counter.increment()).toBeGreaterThanOrEqual(0);
    },
  },
]);

function createValidCounter(): Counter {
  let value = 0;
  return { increment: () => ++value };
}

function createBrokenCounter(): Counter {
  // Violates "increments by exactly 1": jumps by 2 every time.
  let value = -2;
  return { increment: () => (value += 2) };
}

describe("runConformanceSuite", () => {
  runConformanceSuite(counterSuite, createValidCounter);
});

describe("a deliberately broken implementation", () => {
  it("fails the invariant the suite is meant to catch", () => {
    const broken = createBrokenCounter();
    const first = broken.increment();
    const second = broken.increment();
    expect(() => expect(second).toBe(first + 1)).toThrow();
  });
});

describe("checkInvariant", () => {
  it("creates a fresh subject per call and disposes it afterwards", async () => {
    let n = 0;
    const seen: number[] = [];
    const disposed: number[] = [];
    const invariant = {
      name: "records",
      check: (subject: { id: number }) => {
        seen.push(subject.id);
      },
    };
    const create = () => ({ id: ++n });
    const dispose = (subject: { id: number }) => {
      disposed.push(subject.id);
    };
    await checkInvariant(invariant, create, dispose);
    await checkInvariant(invariant, create, dispose);
    expect(seen).toEqual([1, 2]);
    expect(disposed).toEqual([1, 2]);
  });

  it("still disposes the subject when the check throws, and rethrows", async () => {
    const dispose = vi.fn();
    const invariant = {
      name: "always fails",
      check() {
        throw new Error("boom");
      },
    };
    await expect(
      checkInvariant(invariant, () => "subject", dispose),
    ).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledWith("subject");
  });
});
