import type { BlockTypeDefinition, BlocksService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { blocksConformanceSuite } from "./blocks.ts";

/** Violates "migration recurses into content": migrates only the root node. */
function createBrokenBlocksService(): BlocksService {
  const types = new Map<string, BlockTypeDefinition>();
  return {
    register(type, definition) {
      if (types.has(type)) throw new Error(`"${type}" is registered`);
      types.set(type, definition);
      return () => types.delete(type);
    },
    isKnown: (type) => types.has(type),
    read(node) {
      const definition = types.get(node.type);
      if (!definition) return node;
      let current = node;
      for (let v = node.v; v < definition.version; v++) {
        const step = definition.migrations?.[v];
        if (!step) throw new Error("missing migration");
        current = step(current);
      }
      return current;
    },
    text: () => "",
  };
}

describe("a deliberately broken blocks implementation", () => {
  it("fails the recursion invariant the suite is meant to catch", async () => {
    const invariant = blocksConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "migration recurses into content, migrating every descendant",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve().then(() =>
        invariant.check(createBrokenBlocksService()),
      ),
    ).rejects.toThrow();
  });
});
