import { describe, expect, it } from "vitest";
import { createSlugger, slugify } from "./slug.ts";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Getting Started!")).toBe("getting-started");
  });

  it("strips accents and keeps non-Latin letters", () => {
    expect(slugify("Café Déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("快速 开始")).toBe("快速-开始");
  });

  it("falls back to a fixed slug when nothing is left", () => {
    expect(slugify("!!!")).toBe("section");
  });
});

describe("createSlugger", () => {
  it("suffixes repeated slugs", () => {
    const slug = createSlugger();
    expect([slug("Usage"), slug("usage"), slug("Usage")]).toEqual([
      "usage",
      "usage-2",
      "usage-3",
    ]);
  });

  it("does not collide with a heading that already ends in a suffix", () => {
    const slug = createSlugger();
    expect([slug("a"), slug("a-2"), slug("a")]).toEqual(["a", "a-2", "a-3"]);
  });
});
