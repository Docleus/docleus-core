import { normalizeInline, stableStringify } from "@docleus/core-markdown";
import type { BlockNode } from "@docleus/sdk";

function indexById(block: BlockNode, into: Map<string, BlockNode>): void {
  into.set(block.id, block);
  for (const child of block.content ?? []) indexById(child, into);
}

/**
 * What a block means regardless of how the editor spells it: no ids, inline
 * content normalized (mark order, merged text), and empty lists dropped.
 */
function canonical(block: BlockNode): unknown {
  const inline = normalizeInline(block.inline ?? []);
  const content = (block.content ?? []).map(canonical);
  return {
    type: block.type,
    v: block.v,
    attrs: block.attrs,
    ...(inline.length > 0 && { inline }),
    ...(content.length > 0 && { content }),
  };
}

function sameMeaning(a: BlockNode, b: BlockNode): boolean {
  return stableStringify(canonical(a)) === stableStringify(canonical(b));
}

/**
 * Replaces every block of `next` that means the same as the block with its
 * id in `previous` by that previous block, so that saving an untouched
 * block does not change its stored form (and with it, the source slice the
 * Markdown exporter keeps for it).
 */
export function reuseUnchanged(
  previous: BlockNode | undefined,
  next: BlockNode,
): BlockNode {
  if (!previous) return next;
  const old = new Map<string, BlockNode>();
  indexById(previous, old);
  const visit = (block: BlockNode): BlockNode => {
    const before = old.get(block.id);
    if (before && sameMeaning(before, block)) return before;
    return block.content
      ? { ...block, content: block.content.map(visit) }
      : block;
  };
  return visit(next);
}
