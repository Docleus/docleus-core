import {
  checkInvariant,
  markdownConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import { Context, type MarkdownService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createMarkdownService } from "./index.ts";

runConformanceSuite(markdownConformanceSuite, () =>
  createMarkdownService(new Context()),
);

/** Violates "an unchanged import exports byte for byte": ignores source slices. */
function createBrokenMarkdownService(): MarkdownService {
  const real = createMarkdownService(new Context());
  return {
    ...real,
    register: (codec) => real.register(codec),
    parse: (markdown, options) => real.parse(markdown, options),
    serialize: ({ source: _source, ...document }) => real.serialize(document),
  };
}

describe("a deliberately broken markdown implementation", () => {
  it("fails the byte-for-byte invariant the suite is meant to catch", async () => {
    const invariant = markdownConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name === "an unchanged import exports byte for byte",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      checkInvariant(invariant, createBrokenMarkdownService),
    ).rejects.toThrow();
  });
});
