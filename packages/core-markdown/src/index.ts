import {
  DocleusError,
  trackCaller,
  type Context,
  type MarkdownCodec,
  type MarkdownService,
} from "@docleus/sdk";
import {
  exportDirectory,
  importDirectory,
  type DocumentCodec,
} from "./directory.ts";
import {
  parseMarkdown,
  serializeMarkdown,
  type ParseOptions,
} from "./engine.ts";
import { BLOCK_DIRECTIVE, INLINE_DIRECTIVE } from "./generic.ts";

export { convertGitbookTags, GITBOOK_NAMESPACE } from "./gitbook.ts";
export { CONFIG_FILE, SUMMARY_FILE, parseSummary } from "./directory.ts";
export { normalizeInline } from "./inline.ts";
export { hashBlock, stableStringify, withoutIds } from "./hash.ts";
export type { ParseOptions };

/** Syntax and types core owns; no codec may claim them. */
const CORE_CLAIMS = new Set([
  "paragraph",
  "text",
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "link",
  "frontmatter",
  `directive:${BLOCK_DIRECTIVE}`,
  `directive:${INLINE_DIRECTIVE}`,
]);
const CORE_BLOCK_TYPES = new Set(["doc", "paragraph", "raw"]);
const CORE_INLINE_TYPES = new Set(["text", "raw"]);

function conflict(message: string): DocleusError {
  return new DocleusError("markdown/syntax-conflict", message);
}

function assertNoConflict(
  codec: MarkdownCodec,
  others: readonly MarkdownCodec[],
): void {
  if (others.some((other) => other.name === codec.name)) {
    throw conflict(`a codec named "${codec.name}" is already registered`);
  }
  const check = (
    values: readonly string[] | undefined,
    core: ReadonlySet<string>,
    pick: (other: MarkdownCodec) => readonly string[] | undefined,
    what: string,
  ): void => {
    for (const value of values ?? []) {
      if (core.has(value)) throw conflict(`${what} "${value}" belongs to core`);
      const owner = others.find((other) => pick(other)?.includes(value));
      if (owner) {
        throw conflict(
          `${what} "${value}" is already claimed by "${owner.name}"`,
        );
      }
    }
  };
  check(codec.claims, CORE_CLAIMS, (other) => other.claims, "syntax");
  check(
    codec.blockTypes,
    CORE_BLOCK_TYPES,
    (other) => other.blockTypes,
    "block type",
  );
  check(
    codec.inlineTypes,
    CORE_INLINE_TYPES,
    (other) => other.inlineTypes,
    "inline type",
  );
}

/**
 * Default `markdown` implementation. Core reads and writes paragraphs with
 * bold, italic, code, strikethrough and link marks; plugin codecs add the
 * rest. Blocks and inline nodes no codec writes export in the generic tag
 * syntax and read back unchanged; Markdown no codec reads is kept verbatim
 * as `raw`.
 *
 * @stability experimental
 */
export function createMarkdownService(ctx: Context): MarkdownService {
  const codecs: MarkdownCodec[] = [];
  const document: DocumentCodec = {
    parse: (markdown, options) => parseMarkdown(codecs, markdown, options),
    serialize: (doc) => serializeMarkdown(codecs, doc),
  };

  return trackCaller<MarkdownService>(ctx, {
    register(codec) {
      return this.ctx.effect(
        () => {
          assertNoConflict(codec, codecs);
          codecs.push(codec);
          return () => {
            const at = codecs.indexOf(codec);
            if (at >= 0) codecs.splice(at, 1);
          };
        },
        `ctx.markdown.register(${JSON.stringify(codec.name)})`,
      );
    },
    parse: (markdown: string, options?: ParseOptions) =>
      parseMarkdown(codecs, markdown, options),
    serialize: (doc) => serializeMarkdown(codecs, doc),
    importDirectory: (files) => importDirectory(files, document),
    exportDirectory: (input) => exportDirectory(input, document),
  });
}

export function provideMarkdown(ctx: Context): () => void {
  return ctx.provide("markdown", createMarkdownService(ctx));
}
