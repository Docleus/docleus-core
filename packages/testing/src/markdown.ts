import {
  createMarkdownService,
  normalizeInline,
  stableStringify,
} from "@docleus/core-markdown";
import {
  Context,
  DocleusError,
  type BlockNode,
  type MarkdownCodec,
} from "@docleus/sdk";

export interface MarkdownRoundTrip {
  /**
   * Prints `block` alone, parses the result, and returns the Markdown.
   * Throws when the parsed block differs from `block` in anything but ids
   * and inline-node grouping.
   */
  roundTrip(block: BlockNode): string;
  /** Throws when `markdown` does not export byte for byte after an unchanged import. */
  preserves(markdown: string): void;
  /**
   * Prints `block` with the codecs unregistered, re-registers them and
   * parses the result; throws unless the block comes back unchanged. This
   * is what happens when a plugin is uninstalled and later reinstalled.
   */
  survivesUninstall(block: BlockNode): string;
}

function comparable(block: BlockNode): unknown {
  const { id: _id, content, inline, ...rest } = block;
  return {
    ...rest,
    ...(inline && { inline: normalizeInline(inline) }),
    ...(content && { content: content.map(comparable) }),
  };
}

function assertSame(
  expected: BlockNode,
  actual: BlockNode | undefined,
  markdown: string,
): void {
  const want = stableStringify(comparable(expected));
  const got =
    actual === undefined ? "nothing" : stableStringify(comparable(actual));
  if (want !== got) {
    throw new DocleusError(
      "testing/round-trip-mismatch",
      `block did not survive the round trip\n  markdown: ${JSON.stringify(markdown)}\n  expected: ${want}\n  received: ${got}`,
    );
  }
}

const doc = (block: BlockNode): BlockNode => ({
  id: "doc",
  type: "doc",
  v: 1,
  attrs: {},
  content: [block],
});

/**
 * Round-trip checks for a plugin's Markdown codecs against the default
 * `markdown` service. Use it from property tests: pass generated blocks to
 * `roundTrip` and `survivesUninstall`, and hand-written files to `preserves`.
 *
 * @stability experimental
 */
export function createMarkdownRoundTrip(
  codecs: readonly MarkdownCodec[],
): MarkdownRoundTrip {
  const markdown = createMarkdownService(new Context());
  let unregister = codecs.map((codec) => markdown.register(codec));

  const parseOne = (text: string): BlockNode | undefined => {
    const content = markdown.parse(text).body.content ?? [];
    return content.length === 1 ? content[0] : undefined;
  };

  return {
    roundTrip(block) {
      const text = markdown.serialize({ body: doc(block) });
      assertSame(block, parseOne(text), text);
      return text;
    },
    preserves(text) {
      const exported = markdown.serialize(markdown.parse(text));
      if (exported !== text) {
        throw new DocleusError(
          "testing/source-not-preserved",
          `unchanged import did not export byte for byte\n  source:   ${JSON.stringify(text)}\n  exported: ${JSON.stringify(exported)}`,
        );
      }
    },
    survivesUninstall(block) {
      for (const dispose of unregister) dispose();
      let text: string;
      try {
        text = markdown.serialize({ body: doc(block) });
      } finally {
        unregister = codecs.map((codec) => markdown.register(codec));
      }
      assertSame(block, parseOne(text), text);
      return text;
    },
  };
}
