import { DocleusError, type Context } from "@docleus/kernel";
import {
  trackCaller,
  type BlockNode,
  type BlocksService,
  type BlockTypeDefinition,
  type InlineNode,
} from "@docleus/sdk";

function migrateNode(
  node: BlockNode,
  definition: BlockTypeDefinition | undefined,
): BlockNode {
  if (!definition) return node;
  let current = node;
  while (current.v < definition.version) {
    const migrate = definition.migrations?.[current.v];
    if (!migrate) {
      throw new DocleusError(
        "blocks/missing-migration",
        `"${node.type}" has no migration from version ${current.v} to ${current.v + 1}`,
      );
    }
    current = migrate(current);
  }
  return current;
}

function inlineText(nodes: readonly InlineNode[] | undefined): string {
  let result = "";
  for (const node of nodes ?? []) {
    if (typeof node.text === "string") result += node.text;
    result += inlineText(node.content);
  }
  return result;
}

/**
 * Default `blocks` implementation: an in-memory type registry with
 * versioned migration and unknown-type passthrough.
 *
 * @stability experimental
 */
export function createBlocksService(ctx: Context): BlocksService {
  const types = new Map<string, BlockTypeDefinition>();

  function register(
    caller: Context,
    type: string,
    definition: BlockTypeDefinition,
  ): () => void {
    return caller.effect(
      () => {
        if (types.has(type)) {
          throw new DocleusError(
            "blocks/already-registered",
            `block type "${type}" is already registered`,
          );
        }
        types.set(type, definition);
        return () => types.delete(type);
      },
      `ctx.blocks.register(${JSON.stringify(type)})`,
    );
  }

  function read(node: BlockNode): BlockNode {
    const migrated = migrateNode(node, types.get(node.type));
    if (!migrated.content) return migrated;
    return { ...migrated, content: migrated.content.map(read) };
  }

  function ownText(node: BlockNode): string {
    const own = types.get(node.type)?.text;
    if (own) return own(node);
    if (node.type === "raw" && typeof node.attrs.source === "string") {
      return node.attrs.source;
    }
    return inlineText(node.inline);
  }

  function text(node: BlockNode): string {
    const lines: string[] = [];
    const visit = (current: BlockNode): void => {
      const line = ownText(current).trim();
      if (line) lines.push(line);
      for (const child of current.content ?? []) visit(child);
    };
    visit(node);
    return lines.join("\n");
  }

  return trackCaller<BlocksService>(ctx, {
    register(type, definition) {
      return register(this.ctx, type, definition);
    },
    isKnown: (type) => types.has(type),
    read,
    text,
  });
}

export function provideBlocks(ctx: Context): () => void {
  return ctx.provide("blocks", createBlocksService(ctx));
}
