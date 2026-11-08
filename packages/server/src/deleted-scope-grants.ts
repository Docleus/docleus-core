import type { Context } from "@docleus/kernel";
import { z } from "zod";

export const DELETED_SCOPE_GRANTS = "@docleus/server/deleted-scope-grants";

const deletedOrg = z.object({ orgId: z.string().min(1) });
const deletedSpace = deletedOrg.extend({ spaceId: z.string().min(1) });

/** Replays deletions before serving requests and keeps their grants removed. */
export async function registerDeletedScopeGrants(ctx: Context): Promise<void> {
  ctx.content.registerProjection({
    name: DELETED_SCOPE_GRANTS,
    async reset() {},
    async apply(entry) {
      if (entry.type === "org/deleted") {
        const { orgId } = deletedOrg.parse(entry.payload);
        await ctx.authz.revokeAll({ kind: "org", orgId });
      } else if (entry.type === "space/deleted") {
        const { orgId, spaceId } = deletedSpace.parse(entry.payload);
        await ctx.authz.revokeAll({ kind: "space", orgId, spaceId });
      }
    },
  });
  await ctx.content.catchUp(DELETED_SCOPE_GRANTS);
}
