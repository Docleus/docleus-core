import { createHash } from "node:crypto";
import { DocleusError } from "@docleus/kernel";
import type { BlockNode, EntryContent, InlineNode } from "@docleus/sdk";
import { z } from "zod";

const record = z.record(z.string(), z.unknown());

const markSchema = z.object({ type: z.string(), attrs: record.optional() });

const inlineSchema: z.ZodType<InlineNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    marks: z.array(markSchema).optional(),
    attrs: record.optional(),
    content: z.array(inlineSchema).optional(),
  }),
);

const blockSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    v: z.number().int().positive(),
    attrs: record,
    content: z.array(blockSchema).optional(),
    inline: z.array(inlineSchema).optional(),
  }),
);

const entryContentSchema = z.object({
  type: z.string().min(1),
  title: z.string(),
  parent: z.string().min(1).optional(),
  order: z.number().finite(),
  fields: record,
  body: blockSchema.optional(),
  meta: record.optional(),
});

/** Revision entry maps as stored: entry id to content hash. */
export const revisionEntriesSchema = z.record(z.string(), z.string());

/**
 * Parses entry content from a commit or from storage. `parent` is always
 * present (possibly `undefined`), matching {@link EntryContent}.
 */
export function parseEntryContent(
  value: unknown,
  code: string,
  what: string,
): EntryContent {
  const result = entryContentSchema.safeParse(value);
  if (!result.success) {
    throw new DocleusError(
      code,
      `${what} is not valid entry content: ${result.error.message}`,
    );
  }
  const { parent, body, meta, ...rest } = result.data;
  return {
    ...rest,
    parent,
    ...(body !== undefined && { body }),
    ...(meta !== undefined && { meta }),
  };
}

/** JSON with object keys sorted and `undefined` members dropped, so equal content hashes equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`,
      );
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashContent(content: EntryContent): {
  hash: string;
  json: string;
} {
  const json = stableStringify(content);
  return { hash: createHash("sha256").update(json).digest("hex"), json };
}
