import type { BlockNode, BlocksService } from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite } from "./suite.ts";

const leaf = (type: string, v: number, id = "a"): BlockNode => ({
  id,
  type,
  v,
  attrs: {},
});

export const blocksConformanceSuite = defineConformanceSuite<BlocksService>(
  "blocks",
  [
    {
      name: "a type is not known before it is registered",
      check(blocks) {
        expect(blocks.isKnown("test.unregistered")).toBe(false);
      },
    },
    {
      name: "register makes the type known; unregistering makes it unknown again",
      check(blocks) {
        const dispose = blocks.register("test.known", { version: 1 });
        expect(blocks.isKnown("test.known")).toBe(true);
        dispose();
        expect(blocks.isKnown("test.known")).toBe(false);
      },
    },
    {
      name: "registering an already-registered type throws",
      check(blocks) {
        blocks.register("test.dup", { version: 1 });
        expect(() => blocks.register("test.dup", { version: 1 })).toThrow();
      },
    },
    {
      name: "a node at the current version is returned unchanged",
      check(blocks) {
        blocks.register("test.current", { version: 1 });
        const node = leaf("test.current", 1);
        expect(blocks.read(node)).toEqual(node);
      },
    },
    {
      name: "a node of an unknown type passes through unchanged",
      check(blocks) {
        const node = leaf("test.unregistered-passthrough", 1);
        expect(blocks.read(node)).toEqual(node);
      },
    },
    {
      name: "a node below the current version runs every migration up to it, in order",
      check(blocks) {
        blocks.register("test.migrated", {
          version: 3,
          migrations: {
            1: (node) => ({
              ...node,
              v: 2,
              attrs: { ...node.attrs, step: "1-to-2" },
            }),
            2: (node) => ({
              ...node,
              v: 3,
              attrs: { ...node.attrs, step: "2-to-3" },
            }),
          },
        });
        const result = blocks.read(leaf("test.migrated", 1));
        expect(result.v).toBe(3);
        expect(result.attrs["step"]).toBe("2-to-3");
      },
    },
    {
      name: "a missing migration step throws rather than silently skipping",
      check(blocks) {
        blocks.register("test.gap", { version: 2, migrations: {} });
        expect(() => blocks.read(leaf("test.gap", 1))).toThrow();
      },
    },
    {
      name: "migration recurses into content, migrating every descendant",
      check(blocks) {
        blocks.register("test.nested", {
          version: 2,
          migrations: { 1: (node) => ({ ...node, v: 2 }) },
        });
        const tree: BlockNode = {
          id: "root",
          type: "test.nested",
          v: 2,
          attrs: {},
          content: [leaf("test.nested", 1, "child")],
        };
        const result = blocks.read(tree);
        expect(result.content?.[0]?.v).toBe(2);
      },
    },
  ],
);
