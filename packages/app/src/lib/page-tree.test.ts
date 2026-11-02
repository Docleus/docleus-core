import { describe, expect, it } from "vitest";
import {
  buildTree,
  orderForStep,
  subtreeIds,
  type PageSummary,
} from "./page-tree.ts";

const page = (
  id: string,
  parent: string | null,
  order: number,
): PageSummary => ({
  id,
  title: id,
  parent,
  order,
});
const pages = [
  page("b", null, 1),
  page("a", null, 0),
  page("c", null, 2),
  page("a1", "a", 0),
  page("a1x", "a1", 0),
];

describe("page tree", () => {
  it("builds a tree sorted by order", () => {
    const tree = buildTree(pages);
    expect(tree.map((node) => node.page.id)).toEqual(["a", "b", "c"]);
    expect(tree[0]?.children[0]?.children[0]?.page.id).toBe("a1x");
  });

  it("computes the order one step up or down", () => {
    const [b] = pages;
    if (!b) throw new Error("fixture");
    expect(orderForStep(pages, b, -1)).toBe(-1);
    expect(orderForStep(pages, b, 1)).toBe(3);
    expect(orderForStep(pages, page("c", null, 2), 1)).toBeUndefined();
    expect(orderForStep(pages, page("a", null, 0), 1)).toBe(1.5);
  });

  it("collects a subtree", () => {
    expect([...subtreeIds(pages, "a")].toSorted()).toEqual(["a", "a1", "a1x"]);
  });
});
