import { describe, expect, it } from "vitest";
import { fullTime, relativeTime } from "./time.ts";

const NOW = new Date(2026, 9, 30, 15, 0).getTime();
const at = (...parts: [number, number, number, number?, number?]) =>
  new Date(...(parts as [number, number, number, number, number])).getTime();

describe("relativeTime", () => {
  it.each([
    [NOW - 10_000, "just now"],
    [NOW - 60_000, "1 minute ago"],
    [NOW - 25 * 60_000, "25 minutes ago"],
    [NOW - 60 * 60_000, "1 hour ago"],
    [at(2026, 9, 30, 9, 0), "6 hours ago"],
    [at(2026, 9, 29, 23, 0), "Yesterday"],
    [at(2026, 9, 27, 12, 0), "3 days ago"],
    [at(2026, 9, 20, 12, 0), "Oct 20"],
    [at(2025, 11, 31, 12, 0), "Dec 31, 2025"],
  ])("shows %s as %s", (time, expected) => {
    expect(relativeTime(time, NOW)).toBe(expected);
  });

  it("says Yesterday for last night even when fewer than 24 hours passed", () => {
    expect(relativeTime(at(2026, 9, 29, 22, 0), at(2026, 9, 30, 1, 0))).toBe(
      "Yesterday",
    );
  });

  it.each([
    [NOW + 20 * 60_000, "in 20 minutes"],
    [at(2026, 9, 30, 20, 0), "in 5 hours"],
    [at(2026, 9, 31, 9, 0), "Tomorrow"],
    [at(2026, 10, 3, 12, 0), "in 4 days"],
    [at(2026, 10, 20, 12, 0), "Nov 20"],
  ])("shows the time ahead %s as %s", (time, expected) => {
    expect(relativeTime(time, NOW)).toBe(expected);
  });
});

describe("fullTime", () => {
  it("names the date and the minute", () => {
    expect(fullTime(at(2026, 9, 28, 13, 16))).toBe("Oct 28, 2026, 1:16 PM");
  });
});
