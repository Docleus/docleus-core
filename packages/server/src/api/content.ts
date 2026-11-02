import { randomBytes } from "node:crypto";
import { DocleusError, type Context } from "@docleus/kernel";
import {
  MAIN_BRANCH,
  PAGE_ENTRY_TYPE,
  fromEditorDocument,
  type Actor,
  type BlockNode,
  type Branch,
  type Entry,
  type EntryContent,
  type HttpRequestContext,
  type Revision,
  type Space,
} from "@docleus/sdk";
import { z } from "zod";
import {
  assertCan,
  handle,
  json,
  param,
  readBody,
  requireSpace,
} from "./respond.ts";
import { reuseUnchanged } from "./reuse.ts";

const SPACE = "/api/orgs/:orgId/spaces/:spaceId";

const createOrgBody = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
});
const updateOrgBody = z.object({
  slug: z.string().min(1).optional(),
  name: z.string().trim().min(1).optional(),
});
const createSpaceBody = createOrgBody.extend({
  description: z.string().max(280).optional(),
});
const updateSpaceBody = updateOrgBody.extend({
  description: z.string().max(280).optional(),
});
const createPageBody = z.object({
  title: z.string(),
  parent: z.string().min(1).nullable().default(null),
  /** A page whose body (and title, unless given) the new page copies. */
  copyOf: z.string().min(1).optional(),
  /** Sort order among siblings; after the last one when absent. */
  order: z.number().finite().optional(),
});
const restoreBody = z.object({
  /** The revision the deleted pages are read from. */
  from: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(1000),
});
const updatePageBody = z.object({
  title: z.string().optional(),
  parent: z.string().min(1).nullable().optional(),
  order: z.number().finite().optional(),
});
const saveBodyBody = z.object({
  /** The revision the editor loaded the page from. */
  base: z.string().min(1).nullable(),
  document: z.unknown(),
});

/** A short random id for entries and blocks created by the API. */
export function createId(): string {
  return randomBytes(8).toString("base64url");
}

/** A copy of `block` whose blocks all have new ids, for duplicated pages. */
export function withFreshIds(block: BlockNode): BlockNode {
  return {
    ...block,
    id: createId(),
    ...(block.content && { content: block.content.map(withFreshIds) }),
  };
}

/** The body of a new page: one empty paragraph. */
export function emptyBody(): BlockNode {
  return {
    id: createId(),
    type: "doc",
    v: 1,
    attrs: {},
    content: [{ id: createId(), type: "paragraph", v: 1, attrs: {} }],
  };
}

interface PageSummary {
  readonly id: string;
  readonly title: string;
  readonly parent: string | null;
  readonly order: number;
  /** The entry's content hash, so clients can tell which pages a branch changed. */
  readonly hash?: string;
}

function summarize(entry: Entry, hash?: string): PageSummary {
  return {
    id: entry.id,
    title: entry.title,
    parent: entry.parent ?? null,
    order: entry.order,
    ...(hash !== undefined && { hash }),
  };
}

function contentOf(entry: Entry): EntryContent {
  const { id: _id, ...content } = entry;
  return content;
}

/** The branch named by `?branch=` (default `main`); unknown branches answer 404. */
async function requireBranch(
  ctx: Context,
  context: HttpRequestContext,
  space: Space,
): Promise<Branch> {
  const name =
    new URL(context.request.url).searchParams.get("branch") ?? MAIN_BRANCH;
  const branch = await ctx.content.getBranch(space.id, name);
  if (!branch) {
    throw new DocleusError(
      "api/branch-not-found",
      `space "${space.id}" has no branch "${name}"`,
    );
  }
  return branch;
}

async function headEntries(
  ctx: Context,
  branch: Branch,
): Promise<{ head: Revision | undefined; entries: Entry[] }> {
  const head = await ctx.content.head(branch.spaceId, branch.name);
  const entries = head ? await ctx.content.listEntries(head.id) : [];
  return { head, entries };
}

/** The fields every API commit carries: the branch it targets and who made it. */
function commitTarget(
  branch: Branch,
  actor: Actor,
): { spaceId: string; branch: string; author?: string } {
  return {
    spaceId: branch.spaceId,
    branch: branch.name,
    ...(actor.kind === "user" && { author: actor.userId }),
  };
}

function findPage(entries: readonly Entry[], pageId: string): Entry {
  const entry = entries.find(
    (candidate) =>
      candidate.id === pageId && candidate.type === PAGE_ENTRY_TYPE,
  );
  if (!entry) {
    throw new DocleusError(
      "api/page-not-found",
      `page "${pageId}" does not exist`,
    );
  }
  return entry;
}

function descendantsOf(entries: readonly Entry[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const entry of entries) {
      if (entry.parent === out[i]) out.push(entry.id);
    }
  }
  return out;
}

function nextOrder(entries: readonly Entry[], parent: string | undefined) {
  const siblings = entries.filter((entry) => entry.parent === parent);
  return siblings.reduce((max, entry) => Math.max(max, entry.order), -1) + 1;
}

/**
 * The instance API for organizations, spaces and the page tree. Every
 * route checks the caller's role on the resource it touches. Space and
 * page routes work on the branch named by `?branch=` (default `main`);
 * page writes commit a new revision on that branch's head.
 */
export function registerContentApi(ctx: Context): void {
  ctx.http.route(
    "GET",
    "/api/me",
    handle(ctx, async ({ actor }) => {
      if (actor.kind !== "user") return json({ user: null });
      const user = await ctx.identity.getUser(actor.userId);
      const isAdmin = await ctx.authz.can(actor, "manage", {
        kind: "instance",
      });
      return json({ user: user ?? null, isAdmin });
    }),
  );

  ctx.http.route(
    "GET",
    "/api/orgs",
    handle(ctx, async ({ actor }) => {
      const orgs = await ctx.content.listOrgs();
      const isVisible = await ctx.authz.canEach(
        actor,
        "read",
        orgs.map((org) => ({ kind: "org", orgId: org.id }) as const),
      );
      return json({ orgs: orgs.filter((_, index) => isVisible[index]) });
    }),
  );

  ctx.http.route(
    "POST",
    "/api/orgs",
    handle(ctx, async ({ request, actor }) => {
      const org = await ctx.content.createOrg(
        await readBody(request, createOrgBody),
      );
      if (actor.kind === "user") {
        await ctx.authz.grant(
          actor.userId,
          { kind: "org", orgId: org.id },
          "owner",
        );
      }
      return json({ org }, 201);
    }),
    { authorize: { action: "manage", resource: { kind: "instance" } } },
  );

  ctx.http.route(
    "GET",
    "/api/orgs/:orgId",
    handle(ctx, async (context) => {
      const orgId = param(context, "orgId");
      await assertCan(ctx, context.actor, "read", { kind: "org", orgId });
      const org = await ctx.content.getOrg(orgId);
      if (!org) {
        throw new DocleusError(
          "api/org-not-found",
          `org "${orgId}" does not exist`,
        );
      }
      const all = await ctx.content.listSpaces(orgId);
      const isVisible = await ctx.authz.canEach(
        context.actor,
        "read",
        all.map(
          (space) => ({ kind: "space", orgId, spaceId: space.id }) as const,
        ),
      );
      const visible = all.filter((_, index) => isVisible[index]);
      const heads = await ctx.content.heads(visible.map((space) => space.id));
      const spaces = visible.map((space, index) => {
        const head = heads[index];
        return {
          ...space,
          pageCount: Object.keys(head?.entries ?? {}).length,
          editedAt: head?.at ?? null,
        };
      });
      return json({ org, spaces });
    }),
  );

  ctx.http.route(
    "POST",
    "/api/orgs/:orgId/spaces",
    handle(ctx, async (context) => {
      const orgId = param(context, "orgId");
      await assertCan(ctx, context.actor, "manage", { kind: "org", orgId });
      const input = await readBody(context.request, createSpaceBody);
      const space = await ctx.content.createSpace({ orgId, ...input });
      return json({ space }, 201);
    }),
  );

  ctx.http.route(
    "PATCH",
    "/api/orgs/:orgId",
    handle(ctx, async (context) => {
      const orgId = param(context, "orgId");
      await assertCan(ctx, context.actor, "manage", { kind: "org", orgId });
      const input = await readBody(context.request, updateOrgBody);
      return json({ org: await ctx.content.updateOrg(orgId, input) });
    }),
  );

  ctx.http.route(
    "DELETE",
    "/api/orgs/:orgId",
    handle(ctx, async (context) => {
      const orgId = param(context, "orgId");
      const { actor } = context;
      const isOwner =
        actor.kind === "user" &&
        ((await ctx.authz.can(actor, "manage", { kind: "instance" })) ||
          (await ctx.authz.roleAt(actor.userId, { kind: "org", orgId })) ===
            "owner");
      if (!isOwner) {
        await assertCan(ctx, actor, "read", { kind: "org", orgId });
        throw new DocleusError(
          "api/forbidden",
          "only an owner can delete an organization",
        );
      }
      await ctx.content.deleteOrg(orgId);
      return new Response(null, { status: 204 });
    }),
  );

  ctx.http.route(
    "PATCH",
    SPACE,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      const input = await readBody(context.request, updateSpaceBody);
      return json({ space: await ctx.content.updateSpace(space.id, input) });
    }),
  );

  ctx.http.route(
    "DELETE",
    SPACE,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      await ctx.content.deleteSpace(space.id);
      return new Response(null, { status: 204 });
    }),
  );

  ctx.http.route(
    "GET",
    SPACE,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "read");
      const branch = await requireBranch(ctx, context, space);
      const { head, entries } = await headEntries(ctx, branch);
      const pages = entries
        .filter((entry) => entry.type === PAGE_ENTRY_TYPE)
        .map((entry) => summarize(entry, head?.entries[entry.id]));
      const canWrite = await ctx.authz.can(context.actor, "write", {
        kind: "space",
        orgId: space.orgId,
        spaceId: space.id,
      });
      return json({
        space,
        branch,
        head: head?.id ?? null,
        editedAt: head?.at ?? null,
        editedBy: head?.author ?? null,
        pages,
        canWrite,
      });
    }),
  );

  ctx.http.route(
    "GET",
    `${SPACE}/branches`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "read");
      return json({ branches: await ctx.content.listBranches(space.id) });
    }),
  );

  ctx.http.route(
    "POST",
    `${SPACE}/pages`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "write");
      const branch = await requireBranch(ctx, context, space);
      const input = await readBody(context.request, createPageBody);
      const { head, entries } = await headEntries(ctx, branch);
      const parent = input.parent ?? undefined;
      if (parent !== undefined) findPage(entries, parent);
      const source =
        input.copyOf === undefined
          ? undefined
          : findPage(entries, input.copyOf);
      const id = createId();
      const page: EntryContent = {
        type: PAGE_ENTRY_TYPE,
        title: input.title,
        parent,
        order: input.order ?? nextOrder(entries, parent),
        fields: source ? { ...source.fields } : {},
        body: source?.body ? withFreshIds(source.body) : emptyBody(),
      };
      const revision = await ctx.content.commit({
        ...commitTarget(branch, context.actor),
        parent: head?.id,
        put: { [id]: page },
        message: `Create page "${input.title}"`,
      });
      return json({ page: { id, ...page }, head: revision.id }, 201);
    }),
  );

  ctx.http.route(
    "GET",
    `${SPACE}/pages/:pageId`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "read");
      const branch = await requireBranch(ctx, context, space);
      const { head, entries } = await headEntries(ctx, branch);
      const page = findPage(entries, param(context, "pageId"));
      return json({ page, head: head?.id ?? null });
    }),
  );

  ctx.http.route(
    "PATCH",
    `${SPACE}/pages/:pageId`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "write");
      const branch = await requireBranch(ctx, context, space);
      const input = await readBody(context.request, updatePageBody);
      const { head, entries } = await headEntries(ctx, branch);
      const page = findPage(entries, param(context, "pageId"));
      const parent =
        input.parent === undefined ? page.parent : (input.parent ?? undefined);
      if (parent !== undefined) findPage(entries, parent);
      const isMove = parent !== page.parent;
      const next: EntryContent = {
        ...contentOf(page),
        title: input.title ?? page.title,
        parent,
        order:
          input.order ??
          (isMove
            ? nextOrder(
                entries.filter((entry) => entry.id !== page.id),
                parent,
              )
            : page.order),
      };
      const revision = await ctx.content.commit({
        ...commitTarget(branch, context.actor),
        parent: head?.id,
        put: { [page.id]: next },
        message: isMove
          ? `Move page "${next.title}"`
          : `Update page "${next.title}"`,
      });
      return json({
        page: summarize({ id: page.id, ...next }),
        head: revision.id,
      });
    }),
  );

  ctx.http.route(
    "DELETE",
    `${SPACE}/pages/:pageId`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "write");
      const branch = await requireBranch(ctx, context, space);
      const { head, entries } = await headEntries(ctx, branch);
      const page = findPage(entries, param(context, "pageId"));
      const removed = descendantsOf(entries, page.id);
      const revision = await ctx.content.commit({
        ...commitTarget(branch, context.actor),
        parent: head?.id,
        remove: removed,
        message: `Delete page "${page.title}"`,
      });
      // `before` lets the client undo the deletion through `pages/restore`.
      return json({ removed, head: revision.id, before: head?.id ?? null });
    }),
  );

  ctx.http.route(
    "POST",
    `${SPACE}/pages/restore`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "write");
      const branch = await requireBranch(ctx, context, space);
      const input = await readBody(context.request, restoreBody);
      const from = await ctx.content.getRevision(input.from);
      if (from?.spaceId !== space.id) {
        throw new DocleusError(
          "api/invalid-revision",
          `revision "${input.from}" is not in space "${space.id}"`,
        );
      }
      const { head, entries } = await headEntries(ctx, branch);
      const present = new Set(entries.map((entry) => entry.id));
      const put: Record<string, EntryContent> = {};
      for (const id of input.ids) {
        if (present.has(id)) continue;
        const entry = await ctx.content.getEntry(from.id, id);
        if (entry) put[id] = contentOf(entry);
      }
      if (Object.keys(put).length === 0)
        return json({ head: head?.id ?? null });
      const revision = await ctx.content.commit({
        ...commitTarget(branch, context.actor),
        parent: head?.id,
        put,
        message: "Restore deleted pages",
      });
      return json({ head: revision.id });
    }),
  );

  ctx.http.route(
    "PUT",
    `${SPACE}/pages/:pageId/body`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "write");
      const branch = await requireBranch(ctx, context, space);
      const input = await readBody(context.request, saveBodyBody);
      const body = fromEditorDocument(input.document);
      const { head, entries } = await headEntries(ctx, branch);
      const page = findPage(entries, param(context, "pageId"));
      await assertUnchangedSince(ctx, input.base, head, page.id);
      const revision = await ctx.content.commit({
        ...commitTarget(branch, context.actor),
        parent: head?.id,
        put: {
          [page.id]: {
            ...contentOf(page),
            body: reuseUnchanged(page.body, body),
          },
        },
        message: `Edit page "${page.title}"`,
      });
      return json({ head: revision.id });
    }),
  );
}

/**
 * A save based on an older revision is accepted as long as the page's body
 * has not changed since. A save replaces only the body, so edits elsewhere
 * in the space, and renames or moves of the page itself, do not block it.
 */
async function assertUnchangedSince(
  ctx: Context,
  base: string | null,
  head: Revision | undefined,
  pageId: string,
): Promise<void> {
  if (head === undefined || base === head.id) return;
  const before =
    base === null ? undefined : await ctx.content.getRevision(base);
  if (before?.spaceId === head.spaceId) {
    if (before.entries[pageId] === head.entries[pageId]) return;
    const [then, now] = await Promise.all([
      ctx.content.getEntry(before.id, pageId),
      ctx.content.getEntry(head.id, pageId),
    ]);
    // Bodies read back from storage keep their stored key order.
    if (then && now && JSON.stringify(then.body) === JSON.stringify(now.body)) {
      return;
    }
  }
  throw new DocleusError(
    "api/stale-head",
    `page "${pageId}" changed since revision "${base ?? "none"}"`,
  );
}
