import { Context, DocleusError, type Fiber } from "@docleus/kernel";
import { createBlocksService } from "@docleus/core-blocks";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import {
  contentConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import {
  MAIN_BRANCH,
  PAGE_ENTRY_TYPE,
  type BlockNode,
  type BlocksService,
  type ContentService,
  type EntryContent,
  type InstallationsService,
  type LogEntry,
  type PreCommitInput,
  type RevisionCommitted,
} from "@docleus/sdk";
import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createContentService, provideContent } from "./index.ts";
import { contentMigrations, type ContentSchema } from "./schema.ts";

/** The tables as the first two migrations left them, before branches. */
interface LegacySchema {
  orgs: Omit<ContentSchema["orgs"], "deleted_at">;
  spaces: Omit<ContentSchema["spaces"], "description" | "deleted_at">;
  revisions: Omit<ContentSchema["revisions"], "branch" | "author" | "merged">;
  space_heads: { space_id: string; revision_id: string };
}

const fibers: Fiber[] = [];

async function freshContent(): Promise<{
  content: ContentService;
  blocks: BlocksService;
  ctx: Context;
}> {
  let content!: ContentService;
  let owner!: Context;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    ctx.provide("blocks", createBlocksService(ctx));
    content = createContentService(ctx);
    owner = ctx;
  });
  fibers.push(fiber);
  return { content, blocks: owner.blocks, ctx: owner };
}

runConformanceSuite(contentConformanceSuite, freshContent);

afterEach(async () => {
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

describe("createContentService", () => {
  it("emits content/log-appended with the appended entry", async () => {
    const { content, ctx } = await freshContent();
    const seen: LogEntry[] = [];
    ctx.on("content/log-appended", (entry) => {
      seen.push(entry);
    });
    const entry = await content.append("test/event", { ok: true });
    expect(seen).toEqual([entry]);
  });

  it("rejects payloads that cannot be serialized", async () => {
    const { content } = await freshContent();
    await expect(content.append("test/event", undefined)).rejects.toMatchObject(
      { code: "content/invalid-payload" },
    );
    expect(await content.readLog()).toEqual([]);
  });

  it("rejects slugs that are not lowercase kebab-case", async () => {
    const { content } = await freshContent();
    await expect(
      content.createOrg({ slug: "Not A Slug", name: "X" }),
    ).rejects.toMatchObject({ code: "content/invalid-slug" });
  });

  it("reports duplicate slugs with a stable error code", async () => {
    const { content } = await freshContent();
    await content.createOrg({ slug: "acme", name: "A" });
    await expect(
      content.createOrg({ slug: "acme", name: "B" }),
    ).rejects.toMatchObject({ code: "content/slug-taken" });
  });
});

async function freshSpace(content: ContentService): Promise<string> {
  const org = await content.createOrg({ slug: "acme", name: "A" });
  const space = await content.createSpace({
    orgId: org.id,
    slug: "docs",
    name: "D",
  });
  return space.id;
}

const emptyDoc = (): BlockNode => ({
  id: "root",
  type: "doc",
  v: 1,
  attrs: {},
  content: [],
});

const page = (title: string): EntryContent => ({
  type: PAGE_ENTRY_TYPE,
  title,
  parent: undefined,
  order: 0,
  fields: {},
  body: { id: "root", type: "doc", v: 1, attrs: {}, content: [] },
});

describe("revisions", () => {
  it("rejects a stale commit with content/stale-head", async () => {
    const { content } = await freshContent();
    const spaceId = await freshSpace(content);
    await content.commit({ spaceId, parent: undefined, put: {}, message: "1" });
    await expect(
      content.commit({ spaceId, parent: undefined, put: {}, message: "2" }),
    ).rejects.toMatchObject({ code: "content/stale-head" });
  });

  it("emits content/log-appended for a commit only after it is durable", async () => {
    const { content, ctx } = await freshContent();
    const spaceId = await freshSpace(content);
    const heads: (string | undefined)[] = [];
    ctx.on("content/log-appended", (entry) => {
      const { revision } = entry.payload as RevisionCommitted;
      void content.getRevision(revision).then((found) => heads.push(found?.id));
    });
    const revision = await content.commit({
      spaceId,
      parent: undefined,
      put: { a: page("A") },
      message: "1",
    });
    await expect.poll(() => heads).toEqual([revision.id]);
  });

  it("leaves entries of an unregistered type as stored when migrating", async () => {
    const { content } = await freshContent();
    const spaceId = await freshSpace(content);
    const unregister = content.registerEntryType("test.kind", {
      hasBody: true,
    });
    const first = await content.commit({
      spaceId,
      parent: undefined,
      put: {
        kind: {
          ...page("K"),
          type: "test.kind",
          body: {
            id: "r",
            type: "doc",
            v: 1,
            attrs: {},
            content: [{ id: "x", type: "test.old", v: 1, attrs: {} }],
          },
        },
      },
      message: "1",
    });
    unregister();
    expect(await content.migrate(spaceId)).toBeUndefined();
    expect((await content.head(spaceId))?.id).toBe(first.id);
  });

  it("rejects corrupt stored entry content when reading it", async () => {
    const { content, ctx } = await freshContent();
    const spaceId = await freshSpace(content);
    const revision = await content.commit({
      spaceId,
      parent: undefined,
      put: { a: page("A") },
      message: "1",
    });
    const db = ctx.storage.db as unknown as Kysely<ContentSchema>;
    await db
      .updateTable("entry_contents")
      .set({ json: '{"type":1}' })
      .execute();
    await expect(content.getEntry(revision.id, "a")).rejects.toMatchObject({
      code: "content/corrupt-entry",
    });
  });
});

describe("registrations from other plugins", () => {
  it("are undone when the registering plugin unloads", async () => {
    const root = new Context();
    const storageLocation = await testStorageLocation();
    const core = await root.plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      ctx.provide("blocks", createBlocksService(ctx));
      provideContent(ctx);
    });
    fibers.push(core);
    const applied: number[] = [];
    const plugin = await root.plugin({
      inject: ["content"],
      apply: (ctx: Context) => {
        ctx.content.registerEntryType("acme.kind", { hasBody: false });
        ctx.content.registerProjection({
          name: "acme.projection",
          reset: async () => undefined,
          apply: async (entry) => {
            applied.push(entry.seq);
          },
        });
      },
    });
    await root.content.append("test/event", {});
    await root.content.catchUp("acme.projection");
    await plugin.dispose();
    expect(applied).toEqual([1]);
    await expect(root.content.catchUp("acme.projection")).rejects.toMatchObject(
      {
        code: "content/projection-not-found",
      },
    );
    expect(() =>
      root.content.registerEntryType("acme.kind", { hasBody: false }),
    ).not.toThrow();
  });
});

describe("branches", () => {
  it("records the branch, author and merged head on stored revisions", async () => {
    const { content } = await freshContent();
    const spaceId = await freshSpace(content);
    const first = await content.commit({
      spaceId,
      parent: undefined,
      put: { a: page("A") },
      message: "1",
    });
    await content.createBranch({ spaceId, name: "feature" });
    const edit = await content.commit({
      spaceId,
      branch: "feature",
      parent: first.id,
      put: { a: page("B") },
      message: "2",
      author: "user-1",
    });
    const merge = await content.commit({
      spaceId,
      parent: first.id,
      put: { a: page("B") },
      message: "merge",
      author: "user-2",
      merged: edit.id,
    });
    expect(await content.getRevision(edit.id)).toMatchObject({
      branch: "feature",
      author: "user-1",
      merged: undefined,
    });
    expect(await content.getRevision(merge.id)).toMatchObject({
      branch: MAIN_BRANCH,
      author: "user-2",
      merged: edit.id,
    });
  });

  it("rejects a merged head from another space", async () => {
    const { content } = await freshContent();
    const spaceId = await freshSpace(content);
    const [org] = await content.listOrgs();
    if (!org) throw new Error("expected an org");
    const other = await content.createSpace({
      orgId: org.id,
      slug: "other",
      name: "O",
    });
    const elsewhere = await content.commit({
      spaceId: other.id,
      parent: undefined,
      put: {},
      message: "x",
    });
    await expect(
      content.commit({
        spaceId,
        parent: undefined,
        put: {},
        message: "merge",
        merged: elsewhere.id,
      }),
    ).rejects.toMatchObject({ code: "content/invalid-commit" });
  });

  it("reports branch errors with stable codes", async () => {
    const { content } = await freshContent();
    const spaceId = await freshSpace(content);
    const first = await content.commit({
      spaceId,
      parent: undefined,
      put: {},
      message: "1",
    });
    await expect(
      content.createBranch({ spaceId, name: MAIN_BRANCH }),
    ).rejects.toMatchObject({ code: "content/invalid-branch" });
    await expect(
      content.createBranch({ spaceId, name: "Bad Name" }),
    ).rejects.toMatchObject({ code: "content/invalid-branch" });
    await content.createBranch({ spaceId, name: "feature" });
    await expect(
      content.createBranch({ spaceId, name: "feature" }),
    ).rejects.toMatchObject({ code: "content/branch-taken" });
    await expect(
      content.commit({
        spaceId,
        branch: "missing",
        parent: first.id,
        message: "x",
      }),
    ).rejects.toMatchObject({ code: "content/branch-not-found" });
    await expect(
      content.commit({
        spaceId,
        parent: first.id,
        message: "x",
        rebase: first.id,
      }),
    ).rejects.toMatchObject({ code: "content/invalid-commit" });
    await expect(
      content.deleteBranch(spaceId, MAIN_BRANCH),
    ).rejects.toMatchObject({ code: "content/invalid-branch" });
    await expect(
      content.deleteBranch(spaceId, "missing"),
    ).rejects.toMatchObject({ code: "content/branch-not-found" });
    await expect(
      content.createBranch({ spaceId: "missing", name: "x" }),
    ).rejects.toMatchObject({ code: "content/space-not-found" });
  });

  it("creates a branch of an empty space with no head or base", async () => {
    const { content } = await freshContent();
    const spaceId = await freshSpace(content);
    const branch = await content.createBranch({ spaceId, name: "feature" });
    expect(branch).toMatchObject({ head: undefined, base: undefined });
    const revision = await content.commit({
      spaceId,
      branch: "feature",
      parent: undefined,
      put: { a: page("A") },
      message: "1",
    });
    expect(await content.head(spaceId, "feature")).toEqual(revision);
    expect(await content.head(spaceId)).toBeUndefined();
  });

  it("migrates main only", async () => {
    const { content, blocks } = await freshContent();
    const spaceId = await freshSpace(content);
    const old = { id: "n", type: "test.note", v: 1, attrs: { text: "hi" } };
    const first = await content.commit({
      spaceId,
      parent: undefined,
      put: { a: { ...page("A"), body: { ...emptyDoc(), content: [old] } } },
      message: "1",
    });
    await content.createBranch({ spaceId, name: "feature" });
    blocks.register("test.note", {
      version: 2,
      migrations: { 1: (node) => ({ ...node, v: 2 }) },
    });
    const migrated = await content.migrate(spaceId);
    expect(migrated?.branch).toBe(MAIN_BRANCH);
    expect((await content.head(spaceId, "feature"))?.id).toBe(first.id);
  });

  it("moves each space's existing head to main when upgrading", async () => {
    const root = new Context();
    const storageLocation = await testStorageLocation();
    fibers.push(
      await root.plugin((ctx: Context) => {
        ctx.provide("storage", createStorageService(ctx, storageLocation));
      }),
    );
    const db = root.storage.db as unknown as Kysely<LegacySchema>;
    await root.storage.migrate(
      "@docleus/core-content",
      contentMigrations.slice(0, 2),
    );
    await db
      .insertInto("orgs")
      .values({ id: "o", slug: "acme", name: "A" })
      .execute();
    await db
      .insertInto("spaces")
      .values([
        { id: "s1", org_id: "o", slug: "one", name: "1" },
        { id: "s2", org_id: "o", slug: "two", name: "2" },
      ])
      .execute();
    await db
      .insertInto("revisions")
      .values([
        {
          id: "r1",
          space_id: "s1",
          parent: null,
          entries: "{}",
          message: "1",
          at: 10,
        },
        {
          id: "r2",
          space_id: "s1",
          parent: "r1",
          entries: "{}",
          message: "2",
          at: 20,
        },
      ])
      .execute();
    await db
      .insertInto("space_heads")
      .values({ space_id: "s1", revision_id: "r2" })
      .execute();

    let content: ContentService | undefined;
    fibers.push(
      await root.plugin({
        inject: ["storage"],
        apply: (ctx: Context) => {
          ctx.provide("blocks", createBlocksService(ctx));
          content = createContentService(ctx);
        },
      }),
    );
    if (!content) throw new Error("expected the content service");

    expect(await content.getBranch("s1", MAIN_BRANCH)).toEqual({
      spaceId: "s1",
      name: MAIN_BRANCH,
      head: "r2",
      base: undefined,
      createdAt: 10,
    });
    expect(await content.getBranch("s2", MAIN_BRANCH)).toMatchObject({
      head: undefined,
    });
    expect(await content.head("s1")).toMatchObject({
      id: "r2",
      branch: MAIN_BRANCH,
      parent: "r1",
      author: undefined,
      merged: undefined,
    });
    const next = await content.commit({
      spaceId: "s1",
      parent: "r2",
      put: {},
      message: "3",
    });
    expect((await content.head("s1"))?.id).toBe(next.id);
    const tables =
      root.storage.dialect === "sqlite"
        ? await sql<{ name: string }>`
            select name from sqlite_master where type = 'table' and name = 'space_heads'
          `.execute(root.storage.db)
        : await sql<{ name: string }>`
            select table_name as name from information_schema.tables
            where table_schema = current_schema() and table_name = 'space_heads'
          `.execute(root.storage.db);
    expect(tables.rows).toEqual([]);
  });
});

/** Content with an optional `installations` stand-in that disables the named plugins in every space. */
async function contentWithHooks(disabled?: readonly string[]): Promise<{
  root: Context;
  content: ContentService;
}> {
  const root = new Context();
  const storageLocation = await testStorageLocation();
  fibers.push(
    await root.plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      ctx.provide("blocks", createBlocksService(ctx));
      if (disabled) {
        const allows = (plugin: string) => !disabled.includes(plugin);
        ctx.provide("installations", {
          scope: async () => ({
            allows,
            [Context.filter]: (target: Context) => allows(target.fiber.name),
          }),
        } as Partial<InstallationsService> as InstallationsService);
      }
      provideContent(ctx);
    }),
  );
  return { root, content: root.content };
}

async function hookPlugin(
  root: Context,
  name: string,
  listener: (
    input: PreCommitInput,
    next: () => Promise<PreCommitInput>,
  ) => Promise<PreCommitInput>,
): Promise<void> {
  fibers.push(
    await root.plugin({
      name,
      apply: (ctx: Context) => {
        ctx.on("content/pre-commit", listener);
      },
    }),
  );
}

describe("content/pre-commit", () => {
  it("passes the space and the commit with its branch filled in", async () => {
    const { root, content } = await contentWithHooks();
    const spaceId = await freshSpace(content);
    const seen: PreCommitInput[] = [];
    await hookPlugin(root, "@acme/spy", async (input, next) => {
      seen.push(input);
      return next();
    });
    await content.commit({
      spaceId,
      parent: undefined,
      put: {},
      message: "1",
      author: "user-1",
    });
    expect(seen).toEqual([
      {
        space: expect.objectContaining({ id: spaceId, slug: "docs" }),
        commit: {
          spaceId,
          branch: MAIN_BRANCH,
          parent: undefined,
          put: {},
          message: "1",
          author: "user-1",
        },
      },
    ]);
  });

  it("checkCommit runs the hook as a dry run and writes nothing", async () => {
    const { root, content } = await contentWithHooks();
    const spaceId = await freshSpace(content);
    const seen: (boolean | undefined)[] = [];
    await hookPlugin(root, "@acme/guard", async (input, next) => {
      seen.push(input.isDryRun);
      if (input.commit.author === "blocked") {
        throw new DocleusError("acme/commit-rejected", "no edits on main");
      }
      return next();
    });
    const commit = { spaceId, parent: undefined, put: {}, message: "1" };
    await content.checkCommit({ ...commit, author: "allowed" });
    await expect(
      content.checkCommit({ ...commit, author: "blocked" }),
    ).rejects.toMatchObject({ code: "acme/commit-rejected" });
    expect(seen).toEqual([true, true]);
    expect(await content.head(spaceId)).toBeUndefined();
    expect(await content.readLog()).toEqual([]);
  });

  it("rejects a commit when a listener throws, writing nothing", async () => {
    const { root, content } = await contentWithHooks();
    const spaceId = await freshSpace(content);
    await hookPlugin(root, "@acme/guard", async () => {
      throw new DocleusError("acme/commit-rejected", "no edits on main");
    });
    await expect(
      content.commit({ spaceId, parent: undefined, put: {}, message: "1" }),
    ).rejects.toMatchObject({ code: "acme/commit-rejected" });
    expect(await content.head(spaceId)).toBeUndefined();
    expect(await content.readLog()).toEqual([]);
  });

  it("commits what a listener rewrote", async () => {
    const { root, content } = await contentWithHooks();
    const spaceId = await freshSpace(content);
    await content.createBranch({ spaceId, name: "draft" });
    await hookPlugin(root, "@acme/redirect", async (input, next) => {
      const resolved = await next();
      return {
        ...resolved,
        commit: {
          ...resolved.commit,
          branch: "draft",
          message: `${resolved.commit.message} (redirected)`,
        },
      };
    });
    const revision = await content.commit({
      spaceId,
      parent: undefined,
      put: { a: page("A") },
      message: "1",
    });
    expect(revision).toMatchObject({
      branch: "draft",
      message: "1 (redirected)",
    });
    expect(await content.head(spaceId)).toBeUndefined();
    expect(await content.head(spaceId, "draft")).toEqual(revision);
  });

  it("rejects a rewrite that moves the commit to another space or is malformed", async () => {
    const { root, content } = await contentWithHooks();
    const spaceId = await freshSpace(content);
    let isMalformed = false;
    await hookPlugin(root, "@acme/broken", async (input) =>
      isMalformed
        ? ({ commit: { spaceId } } as unknown as PreCommitInput)
        : { ...input, commit: { ...input.commit, spaceId: "elsewhere" } },
    );
    await expect(
      content.commit({ spaceId, parent: undefined, message: "1" }),
    ).rejects.toMatchObject({ code: "content/invalid-commit" });
    isMalformed = true;
    await expect(
      content.commit({ spaceId, parent: undefined, message: "1" }),
    ).rejects.toMatchObject({ code: "content/invalid-commit" });
    expect(await content.head(spaceId)).toBeUndefined();
  });

  it("rejects a commit to an unknown space before running the hook", async () => {
    const { root, content } = await contentWithHooks();
    let calls = 0;
    await hookPlugin(root, "@acme/spy", async (_input, next) => {
      calls += 1;
      return next();
    });
    await expect(
      content.commit({ spaceId: "missing", parent: undefined, message: "1" }),
    ).rejects.toMatchObject({ code: "content/space-not-found" });
    expect(calls).toBe(0);
  });

  it("skips listeners of plugins disabled in the space", async () => {
    const { root, content } = await contentWithHooks(["@acme/guard"]);
    const spaceId = await freshSpace(content);
    const ran: string[] = [];
    await hookPlugin(root, "@acme/guard", async () => {
      ran.push("guard");
      throw new DocleusError("acme/commit-rejected", "no edits on main");
    });
    await hookPlugin(root, "@acme/spy", async (_input, next) => {
      ran.push("spy");
      return next();
    });
    const revision = await content.commit({
      spaceId,
      parent: undefined,
      put: {},
      message: "1",
    });
    expect(ran).toEqual(["spy"]);
    expect((await content.head(spaceId))?.id).toBe(revision.id);
  });
});
