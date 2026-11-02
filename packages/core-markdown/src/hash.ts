import { createHash } from "node:crypto";
import type { BlockNode } from "@docleus/sdk";

/** JSON with object keys sorted, so equal values always print the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(
    entries.map(([key, inner]) => [key, sortKeys(inner)]),
  );
}

/** Block content without ids, which are not part of what the author wrote. */
export function withoutIds(block: BlockNode): unknown {
  const { id: _id, content, ...rest } = block;
  return content ? { ...rest, content: content.map(withoutIds) } : rest;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashBlock(block: BlockNode): string {
  return hashText(stableStringify(withoutIds(block)));
}

export function hashValue(value: unknown): string {
  return hashText(stableStringify(value));
}
