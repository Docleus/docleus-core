import { DocleusError } from "@docleus/sdk";
import { parse, stringify } from "yaml";

export interface SplitFrontmatter {
  /** The `---` block including its fences and final line ending, or `""`. */
  readonly raw: string;
  readonly data: Record<string, unknown> | undefined;
  readonly body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

/** Splits a leading YAML frontmatter block from the Markdown body. */
export function splitFrontmatter(markdown: string): SplitFrontmatter {
  const match = FENCE.exec(markdown);
  if (!match || match.index !== 0) {
    return { raw: "", data: undefined, body: markdown };
  }
  const raw = match[0];
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch (error) {
    throw new DocleusError(
      "markdown/invalid-frontmatter",
      "frontmatter is not valid YAML",
      {
        cause: error,
      },
    );
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new DocleusError(
      "markdown/invalid-frontmatter",
      "frontmatter must be a YAML mapping",
    );
  }
  return {
    raw,
    data: data as Record<string, unknown>,
    body: markdown.slice(raw.length),
  };
}

/**
 * Block scalars are off: yaml prints a whitespace-only line such as `" \n"`
 * as a `|+` scalar that reads back as `"\n"`. Quoted strings are exact.
 */
export const YAML_PRINT_OPTIONS = { blockQuote: false } as const;

export function printFrontmatter(
  data: Readonly<Record<string, unknown>>,
): string {
  return `---\n${stringify(data, YAML_PRINT_OPTIONS)}---\n`;
}
