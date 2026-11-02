import { createCalloutCodec } from "@docleus/conformance";
import type { BlockNode, MarkdownCodec } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createMarkdownRoundTrip } from "./markdown.ts";

const callout: BlockNode = {
  id: "c",
  type: "test.callout",
  v: 1,
  attrs: { tone: "warn" },
  content: [
    {
      id: "p",
      type: "paragraph",
      v: 1,
      attrs: {},
      inline: [{ type: "text", text: "Careful." }],
    },
  ],
};

describe("createMarkdownRoundTrip", () => {
  const tool = createMarkdownRoundTrip([createCalloutCodec()]);

  it("returns the codec's Markdown for a block that round-trips", () => {
    expect(tool.roundTrip(callout)).toBe(
      ':::callout{tone="warn"}\nCareful.\n:::\n',
    );
  });

  it("returns the generic tag a block exports as while its plugin is uninstalled", () => {
    expect(tool.survivesUninstall(callout)).toContain('type="test.callout"');
    expect(tool.roundTrip(callout)).toContain(":::callout");
  });

  it("accepts Markdown that exports unchanged", () => {
    expect(() =>
      tool.preserves("*  odd   list\n\n:::callout{tone=x}\nA\n:::\n"),
    ).not.toThrow();
  });

  it("reports a codec that loses data", () => {
    const codec = createCalloutCodec();
    const write = codec.fromBlock;
    if (!write) throw new Error("expected the callout codec to write blocks");
    const lossy: MarkdownCodec = {
      ...codec,
      fromBlock: (block, context) =>
        write({ ...block, attrs: { tone: "info" } }, context),
    };
    expect(() => createMarkdownRoundTrip([lossy]).roundTrip(callout)).toThrow(
      expect.objectContaining({ code: "testing/round-trip-mismatch" }),
    );
  });
});
