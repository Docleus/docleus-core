import {
  MAIN_BRANCH,
  PAGE_ENTRY_TYPE,
  REVISION_COMMITTED,
  type BlockNode,
  type BlocksService,
  type ContentService,
  type EntryContent,
  type LogEntry,
  type Projection,
  type Space,
} from "@docleus/sdk";
import { expect } from "vitest";
import { z } from "zod";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

/** Content needs the blocks service it migrates bodies through. */
export interface ContentSubject {
  readonly content: ContentService;
  readonly blocks: BlocksService;
}

async function createSpace(content: ContentService): Promise<Space> {
  const org = await content.createOrg({ slug: "acme", name: "Acme" });
  return content.createSpace({ orgId: org.id, slug: "docs", name: "Docs" });
}

function page(
  title: string,
  children: readonly BlockNode[] = [],
  parent?: string,
): EntryContent {
  return {
    type: PAGE_ENTRY_TYPE,
    title,
    parent,
    order: 0,
    fields: {},
    body: { id: "root", type: "doc", v: 1, attrs: {}, content: children },
  };
}

function recorder(
  name: string,
  fail?: (entry: LogEntry) => boolean,
): Projection & {
  seen: number[];
  resets: number;
} {
  return {
    name,
    seen: [],
    resets: 0,
    async reset() {
      this.seen = [];
      this.resets += 1;
    },
    async apply(entry) {
      if (fail?.(entry)) throw new Error(`apply failed at ${entry.seq}`);
      this.seen.push(entry.seq);
    },
  };
}

function endpoint(fields: Record<string, unknown>): EntryContent {
  return {
    type: "test.endpoint",
    title: "E",
    parent: undefined,
    order: 0,
    fields,
  };
}

async function appendEvents(
  content: ContentService,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) await content.append("test/event", { i });
}

export const contentConformanceSuite = defineConformanceSuite<ContentSubject>(
  "content",
  [
    {
      name: "a created org can be read back by id and appears in listOrgs",
      async check({ content }) {
        const org = await content.createOrg({ slug: "acme", name: "Acme" });
        expect(await content.getOrg(org.id)).toEqual(org);
        expect(await content.listOrgs()).toContainEqual(org);
      },
    },
    {
      name: "getOrg with an unknown id returns undefined",
      async check({ content }) {
        expect(await content.getOrg("no-such-org")).toBeUndefined();
      },
    },
    {
      name: "org slugs are unique",
      async check({ content }) {
        await content.createOrg({ slug: "dup", name: "First" });
        await expectToReject(() =>
          content.createOrg({ slug: "dup", name: "Second" }),
        );
      },
    },
    {
      name: "spaces are listed only under their own org",
      async check({ content }) {
        const a = await content.createOrg({ slug: "org-a", name: "A" });
        const b = await content.createOrg({ slug: "org-b", name: "B" });
        const space = await content.createSpace({
          orgId: a.id,
          slug: "docs",
          name: "Docs",
        });
        expect(space.orgId).toBe(a.id);
        expect(await content.listSpaces(a.id)).toEqual([space]);
        expect(await content.listSpaces(b.id)).toEqual([]);
      },
    },
    {
      name: "space slugs are unique within an org but may repeat across orgs",
      async check({ content }) {
        const a = await content.createOrg({ slug: "org-a", name: "A" });
        const b = await content.createOrg({ slug: "org-b", name: "B" });
        await content.createSpace({ orgId: a.id, slug: "docs", name: "1" });
        await content.createSpace({ orgId: b.id, slug: "docs", name: "2" });
        await expectToReject(() =>
          content.createSpace({ orgId: a.id, slug: "docs", name: "3" }),
        );
      },
    },
    {
      name: "creating a space in an unknown org is rejected",
      async check({ content }) {
        await expectToReject(() =>
          content.createSpace({ orgId: "no-such-org", slug: "x", name: "X" }),
        );
      },
    },
    {
      name: "updateOrg changes the name and slug, frees the old slug and logs org/updated",
      async check({ content }) {
        const org = await content.createOrg({ slug: "old", name: "Old" });
        const updated = await content.updateOrg(org.id, {
          slug: "new",
          name: "New",
        });
        expect(updated).toEqual({ id: org.id, slug: "new", name: "New" });
        expect(await content.getOrg(org.id)).toEqual(updated);
        await content.createOrg({ slug: "old", name: "Reuses the slug" });
        const taken = await content.createOrg({ slug: "taken", name: "T" });
        await expectToReject(() =>
          content.updateOrg(taken.id, { slug: "new" }),
        );
        await expectToReject(() => content.updateOrg("no-such-org", {}));
        const log = await content.readLog();
        expect(
          log.filter((entry) => entry.type === "org/updated"),
        ).toHaveLength(1);
      },
    },
    {
      name: "updateSpace changes name, slug and description and logs space/updated",
      async check({ content }) {
        const space = await createSpace(content);
        const updated = await content.updateSpace(space.id, {
          name: "Guides",
          description: "How we work.",
        });
        expect(updated).toMatchObject({
          id: space.id,
          orgId: space.orgId,
          slug: "docs",
          name: "Guides",
          description: "How we work.",
        });
        expect(await content.listSpaces(space.orgId)).toEqual([updated]);
        const other = await content.createSpace({
          orgId: space.orgId,
          slug: "other",
          name: "Other",
        });
        await expectToReject(() =>
          content.updateSpace(other.id, { slug: "docs" }),
        );
        await expectToReject(() =>
          content.updateSpace(space.id, { slug: "Not A Slug" }),
        );
        const log = await content.readLog();
        expect(
          log.filter((entry) => entry.type === "space/updated"),
        ).toHaveLength(1);
      },
    },
    {
      name: "a deleted space disappears, frees its slug, rejects commits and logs space/deleted",
      async check({ content }) {
        const space = await createSpace(content);
        await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "init",
        });
        await content.deleteSpace(space.id);
        expect(await content.listSpaces(space.orgId)).toEqual([]);
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: undefined,
            put: { more: page("More") },
            message: "after delete",
          }),
        );
        await expectToReject(() => content.deleteSpace(space.id));
        const again = await content.createSpace({
          orgId: space.orgId,
          slug: space.slug,
          name: "Again",
        });
        expect(again.id).not.toBe(space.id);
        const deleted = (await content.readLog()).filter(
          (entry) => entry.type === "space/deleted",
        );
        expect(deleted.map((entry) => entry.payload)).toEqual([
          { spaceId: space.id, orgId: space.orgId },
        ]);
      },
    },
    {
      name: "a deleted org disappears with its spaces, logging space/deleted before org/deleted",
      async check({ content }) {
        const space = await createSpace(content);
        const kept = await content.createOrg({ slug: "kept", name: "Kept" });
        await content.deleteOrg(space.orgId);
        expect(await content.getOrg(space.orgId)).toBeUndefined();
        expect(await content.listOrgs()).toEqual([kept]);
        expect(await content.listSpaces(space.orgId)).toEqual([]);
        await expectToReject(() => content.deleteOrg(space.orgId));
        await content.createOrg({ slug: "acme", name: "Reuses the slug" });
        const types = (await content.readLog())
          .map((entry) => entry.type)
          .filter((type) => type.endsWith("/deleted"));
        expect(types).toEqual(["space/deleted", "org/deleted"]);
      },
    },
    {
      name: "log sequence numbers start at 1 and increase by exactly 1",
      async check({ content }) {
        const entries = [];
        for (let i = 0; i < 5; i++) {
          entries.push(await content.append("test/event", { i }));
        }
        expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
      },
    },
    {
      name: "concurrent appends still get distinct, gapless sequence numbers",
      async check({ content }) {
        const entries = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            content.append("test/event", { i }),
          ),
        );
        const seqs = entries
          .map((entry) => entry.seq)
          .toSorted((x, y) => x - y);
        expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      },
    },
    {
      name: "readLog returns entries after afterSeq in order, honoring limit",
      async check({ content }) {
        for (let i = 0; i < 5; i++) {
          await content.append("test/event", { i });
        }
        const slice = await content.readLog({ afterSeq: 2, limit: 2 });
        expect(slice.map((entry) => entry.seq)).toEqual([3, 4]);
        expect(slice.map((entry) => entry.payload)).toEqual([
          { i: 2 },
          { i: 3 },
        ]);
        expect(await content.readLog()).toHaveLength(5);
      },
    },
    {
      name: "a read-back entry matches what append returned",
      async check({ content }) {
        const appended = await content.append("test/event", {
          nested: { list: [1, "two", null] },
        });
        const [read] = await content.readLog({ afterSeq: appended.seq - 1 });
        expect(read).toEqual(appended);
      },
    },
    {
      name: "the first commit of a space becomes its head, with no parent",
      async check({ content }) {
        const space = await createSpace(content);
        expect(await content.head(space.id)).toBeUndefined();
        const revision = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "init",
        });
        expect(revision.parent).toBeUndefined();
        expect(await content.head(space.id)).toEqual(revision);
        expect(await content.getRevision(revision.id)).toEqual(revision);
        expect(await content.getEntry(revision.id, "home")).toEqual({
          id: "home",
          ...page("Home"),
        });
      },
    },
    {
      name: "unchanged entries keep their content hash across revisions, and old revisions do not change",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { a: page("A"), b: page("B") },
          message: "1",
        });
        const second = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { b: page("B2") },
          message: "2",
        });
        expect(second.entries.a).toBe(first.entries.a);
        expect(second.entries.b).not.toBe(first.entries.b);
        expect((await content.getEntry(first.id, "b"))?.title).toBe("B");
        expect((await content.getEntry(second.id, "b"))?.title).toBe("B2");
      },
    },
    {
      name: "heads returns each space's head in the order asked, undefined before a first commit",
      async check({ content }) {
        const first = await createSpace(content);
        const second = await content.createSpace({
          orgId: first.orgId,
          slug: "guides",
          name: "Guides",
        });
        const empty = await content.createSpace({
          orgId: first.orgId,
          slug: "empty",
          name: "Empty",
        });
        for (const space of [first, second]) {
          await content.commit({
            spaceId: space.id,
            parent: undefined,
            put: { home: page(space.name) },
            message: "init",
          });
        }
        const ids = [second.id, empty.id, first.id];
        const heads = await content.heads(ids);
        expect(heads).toHaveLength(3);
        for (const [index, id] of ids.entries()) {
          expect(heads[index]).toEqual(await content.head(id));
        }
        expect(heads[1]).toBeUndefined();
        expect(await content.heads([])).toEqual([]);
      },
    },
    {
      name: "a commit whose parent is not the current head is rejected and leaves the head alone",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { a: page("A") },
          message: "1",
        });
        const second = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { a: page("A2") },
          message: "2",
        });
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: first.id,
            put: { a: page("stale") },
            message: "3",
          }),
        );
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: undefined,
            put: { a: page("stale") },
            message: "4",
          }),
        );
        expect(await content.head(space.id)).toEqual(second);
      },
    },
    {
      name: "of concurrent commits on the same head, exactly one succeeds",
      async check({ content }) {
        const space = await createSpace(content);
        const base = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: {},
          message: "0",
        });
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, (_, i) =>
            content.commit({
              spaceId: space.id,
              parent: base.id,
              put: { a: page(`A${i}`) },
              message: `${i}`,
            }),
          ),
        );
        const won = results.filter((result) => result.status === "fulfilled");
        expect(won).toHaveLength(1);
        expect((await content.head(space.id))?.id).toBe(won[0]?.value.id);
      },
    },
    {
      name: "every commit appends one revision/committed entry naming changed and removed entries",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { a: page("A"), b: page("B"), c: page("C") },
          message: "1",
        });
        const second = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { a: page("A"), b: page("B2") },
          remove: ["c"],
          message: "2",
        });
        const log = await content.readLog();
        expect(log.map((entry) => entry.type)).toEqual([
          REVISION_COMMITTED,
          REVISION_COMMITTED,
        ]);
        expect(log.map((entry) => entry.payload)).toEqual([
          {
            spaceId: space.id,
            revision: first.id,
            branch: MAIN_BRANCH,
            changed: ["a", "b", "c"],
            removed: [],
          },
          {
            spaceId: space.id,
            revision: second.id,
            parent: first.id,
            branch: MAIN_BRANCH,
            changed: ["b"],
            removed: ["c"],
          },
        ]);
        expect(Object.keys(second.entries).toSorted()).toEqual(["a", "b"]);
        expect(await content.getEntry(second.id, "c")).toBeUndefined();
        expect(await content.getEntry(first.id, "c")).toBeDefined();
      },
    },
    {
      name: "every space has main, listed first, which commits default to",
      async check({ content }) {
        const space = await createSpace(content);
        const main = await content.getBranch(space.id, MAIN_BRANCH);
        expect(main).toMatchObject({
          spaceId: space.id,
          name: MAIN_BRANCH,
          head: undefined,
          base: undefined,
        });
        expect(await content.listBranches(space.id)).toEqual([main]);
        const revision = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "init",
        });
        expect(revision.branch).toBe(MAIN_BRANCH);
        expect(await content.head(space.id, MAIN_BRANCH)).toEqual(revision);
        expect((await content.getBranch(space.id, MAIN_BRANCH))?.head).toBe(
          revision.id,
        );
        await content.createBranch({ spaceId: space.id, name: "b" });
        await content.createBranch({ spaceId: space.id, name: "a" });
        expect(
          (await content.listBranches(space.id)).map((branch) => branch.name),
        ).toEqual([MAIN_BRANCH, "a", "b"]);
      },
    },
    {
      name: "a branch starts at main's head, and commits on it move only that branch",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "1",
        });
        const branch = await content.createBranch({
          spaceId: space.id,
          name: "cr/1",
        });
        expect(branch).toMatchObject({
          spaceId: space.id,
          name: "cr/1",
          head: first.id,
          base: first.id,
        });
        const other = await content.createBranch({
          spaceId: space.id,
          name: "other",
          from: first.id,
        });
        const onBranch = await content.commit({
          spaceId: space.id,
          branch: "cr/1",
          parent: first.id,
          put: { home: page("Branch") },
          message: "2",
        });
        expect(onBranch.branch).toBe("cr/1");
        expect(onBranch.parent).toBe(first.id);
        expect(await content.head(space.id)).toEqual(first);
        expect(await content.head(space.id, "cr/1")).toEqual(onBranch);
        expect(await content.getBranch(space.id, "other")).toEqual(other);
        expect((await content.getEntry(onBranch.id, "home"))?.title).toBe(
          "Branch",
        );
        expect((await content.getEntry(first.id, "home"))?.title).toBe("Home");
        const onMain = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { home: page("Main") },
          message: "3",
        });
        expect(await content.head(space.id, "cr/1")).toEqual(onBranch);
        expect((await content.getBranch(space.id, "cr/1"))?.base).toBe(
          first.id,
        );
        const log = await content.readLog();
        expect(log.map((entry) => entry.payload)).toMatchObject([
          { revision: first.id, branch: MAIN_BRANCH },
          { revision: onBranch.id, branch: "cr/1" },
          { revision: onMain.id, branch: MAIN_BRANCH },
        ]);
      },
    },
    {
      name: "commits record their author and merged head",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "1",
        });
        expect(first.author).toBeUndefined();
        expect(first.merged).toBeUndefined();
        await content.createBranch({ spaceId: space.id, name: "feature" });
        const edit = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: first.id,
          put: { home: page("Edited") },
          message: "2",
          author: "user-1",
        });
        const merge = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { home: page("Edited") },
          message: "merge",
          author: "user-2",
          merged: edit.id,
        });
        expect(edit.author).toBe("user-1");
        expect(merge).toMatchObject({ author: "user-2", merged: edit.id });
        expect(await content.getRevision(merge.id)).toEqual(merge);
      },
    },
    {
      name: "the stale-head check is per branch, and commits to an unknown branch are rejected",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "1",
        });
        await content.createBranch({ spaceId: space.id, name: "feature" });
        const onBranch = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: first.id,
          put: { home: page("B") },
          message: "2",
        });
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            branch: "feature",
            parent: first.id,
            put: { home: page("stale") },
            message: "3",
          }),
        );
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: onBranch.id,
            put: { home: page("wrong branch") },
            message: "4",
          }),
        );
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            branch: "missing",
            parent: first.id,
            put: { home: page("missing") },
            message: "5",
          }),
        );
        const onMain = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { home: page("M") },
          message: "6",
        });
        expect(await content.head(space.id)).toEqual(onMain);
        expect(await content.head(space.id, "feature")).toEqual(onBranch);
      },
    },
    {
      name: "createBranch rejects invalid or taken names, main, and a start that is not a revision of main in the space",
      async check({ content }) {
        const space = await createSpace(content);
        for (const name of [
          MAIN_BRANCH,
          "",
          "Feature",
          "-x",
          "has space",
          `a${"b".repeat(100)}`,
        ]) {
          await expectToReject(() =>
            content.createBranch({ spaceId: space.id, name }),
          );
        }
        await content.createBranch({ spaceId: space.id, name: "a.b_c-d/1" });
        await expectToReject(() =>
          content.createBranch({ spaceId: space.id, name: "a.b_c-d/1" }),
        );
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "1",
        });
        await content.createBranch({ spaceId: space.id, name: "feature" });
        const onBranch = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: first.id,
          put: { home: page("B") },
          message: "2",
        });
        const other = await content.createSpace({
          orgId: space.orgId,
          slug: "other",
          name: "Other",
        });
        const elsewhere = await content.commit({
          spaceId: other.id,
          parent: undefined,
          put: { home: page("Other") },
          message: "x",
        });
        for (const from of [onBranch.id, elsewhere.id, "no-such-revision"]) {
          await expectToReject(() =>
            content.createBranch({ spaceId: space.id, name: "late", from }),
          );
        }
        expect(await content.getBranch(space.id, "late")).toBeUndefined();
        await expectToReject(() =>
          content.createBranch({ spaceId: "no-such-space", name: "x" }),
        );
      },
    },
    {
      name: "deleteBranch removes a branch, keeps its revisions readable, and rejects main and unknown branches",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "1",
        });
        await content.createBranch({ spaceId: space.id, name: "feature" });
        const onBranch = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: first.id,
          put: { home: page("B") },
          message: "2",
        });
        await content.deleteBranch(space.id, "feature");
        expect(await content.getBranch(space.id, "feature")).toBeUndefined();
        expect(await content.head(space.id, "feature")).toBeUndefined();
        expect(
          (await content.listBranches(space.id)).map((branch) => branch.name),
        ).toEqual([MAIN_BRANCH]);
        expect(await content.getRevision(onBranch.id)).toEqual(onBranch);
        expect((await content.getEntry(onBranch.id, "home"))?.title).toBe("B");
        await expectToReject(() => content.deleteBranch(space.id, "feature"));
        await expectToReject(() => content.deleteBranch(space.id, MAIN_BRANCH));
        expect(await content.head(space.id)).toEqual(first);
        await content.createBranch({ spaceId: space.id, name: "feature" });
        expect(await content.head(space.id, "feature")).toEqual(first);
      },
    },
    {
      name: "a commit with rebase sets the branch's base to that main revision; rebase on main or to another revision is rejected",
      async check({ content }) {
        const space = await createSpace(content);
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home") },
          message: "1",
        });
        await content.createBranch({ spaceId: space.id, name: "feature" });
        const onBranch = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: first.id,
          put: { b: page("B") },
          message: "2",
        });
        const onMain = await content.commit({
          spaceId: space.id,
          parent: first.id,
          put: { home: page("Main") },
          message: "3",
        });
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: onMain.id,
            put: {},
            message: "rebase main",
            rebase: first.id,
          }),
        );
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            branch: "feature",
            parent: onBranch.id,
            put: {},
            message: "rebase onto itself",
            rebase: onBranch.id,
          }),
        );
        expect(await content.getBranch(space.id, "feature")).toMatchObject({
          head: onBranch.id,
          base: first.id,
        });
        expect(await content.head(space.id)).toEqual(onMain);
        const rebased = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: onBranch.id,
          put: { home: page("Main") },
          message: "rebase",
          rebase: onMain.id,
        });
        expect(await content.getBranch(space.id, "feature")).toMatchObject({
          head: rebased.id,
          base: onMain.id,
        });
        const plain = await content.commit({
          spaceId: space.id,
          branch: "feature",
          parent: rebased.id,
          put: { b: page("B2") },
          message: "edit",
        });
        expect(await content.getBranch(space.id, "feature")).toMatchObject({
          head: plain.id,
          base: onMain.id,
        });
      },
    },
    {
      name: "a commit with an entry of an unknown type or with invalid fields is rejected",
      async check({ content }) {
        const space = await createSpace(content);
        content.registerEntryType("test.endpoint", {
          hasBody: false,
          fields: z.object({ method: z.enum(["GET", "POST"]) }),
        });
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: undefined,
            put: { x: { ...page("X"), type: "test.unregistered" } },
            message: "unknown",
          }),
        );
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: undefined,
            put: { x: endpoint({ method: "PUT" }) },
            message: "bad",
          }),
        );
        expect(await content.head(space.id)).toBeUndefined();
        const revision = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { x: endpoint({ method: "GET" }) },
          message: "ok",
        });
        expect((await content.getEntry(revision.id, "x"))?.fields).toEqual({
          method: "GET",
        });
      },
    },
    {
      name: "registering an entry type that exists, including the built-in page, throws",
      async check({ content }) {
        await expectToReject(() =>
          content.registerEntryType(PAGE_ENTRY_TYPE, { hasBody: true }),
        );
        const unregister = content.registerEntryType("test.kind", {
          hasBody: false,
        });
        await expectToReject(() =>
          content.registerEntryType("test.kind", { hasBody: false }),
        );
        unregister();
        content.registerEntryType("test.kind", { hasBody: false });
      },
    },
    {
      name: "a commit whose entry names a parent missing from the revision is rejected",
      async check({ content }) {
        const space = await createSpace(content);
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: undefined,
            put: { a: page("A", [], "nope") },
            message: "1",
          }),
        );
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { a: page("A"), b: page("B", [], "a") },
          message: "2",
        });
        await expectToReject(() =>
          content.commit({
            spaceId: space.id,
            parent: first.id,
            remove: ["a"],
            message: "orphans b",
          }),
        );
      },
    },
    {
      name: "bodies read migrated to current block versions, and migrate persists that once",
      async check({ content, blocks }) {
        const space = await createSpace(content);
        const old: BlockNode = {
          id: "n",
          type: "test.note",
          v: 1,
          attrs: { text: "hi" },
        };
        const first = await content.commit({
          spaceId: space.id,
          parent: undefined,
          put: { home: page("Home", [old]) },
          message: "1",
        });
        blocks.register("test.note", {
          version: 2,
          migrations: {
            1: (node) => ({ ...node, v: 2, attrs: { body: node.attrs.text } }),
          },
        });
        const read = await content.getEntry(first.id, "home");
        expect(read?.body?.content?.[0]).toEqual({
          id: "n",
          type: "test.note",
          v: 2,
          attrs: { body: "hi" },
        });
        expect((await content.listEntries(first.id))[0]?.body).toEqual(
          read?.body,
        );

        const migrated = await content.migrate(space.id);
        expect(migrated?.parent).toBe(first.id);
        expect(migrated?.entries.home).not.toBe(first.entries.home);
        expect(await content.migrate(space.id)).toBeUndefined();

        // A body written at an old version is stored migrated: the same page
        // committed again with the v1 block hashes like the migrated one.
        const next = await content.commit({
          spaceId: space.id,
          parent: migrated?.id,
          put: { copy: page("Home", [old]) },
          message: "3",
        });
        expect(next.entries.copy).toBe(migrated?.entries.home);
      },
    },
    {
      name: "a projection receives every log entry once, in order, including those appended before it",
      async check({ content }) {
        await appendEvents(content, 3);
        const projection = recorder("test.recorder");
        content.registerProjection(projection);
        await appendEvents(content, 2);
        await content.catchUp(projection.name);
        expect(projection.seen).toEqual([1, 2, 3, 4, 5]);
      },
    },
    {
      name: "a re-registered projection resumes after the last entry it applied",
      async check({ content }) {
        const first = recorder("test.resume");
        const unregister = content.registerProjection(first);
        await appendEvents(content, 2);
        await content.catchUp(first.name);
        unregister();
        await appendEvents(content, 2);
        const second = recorder("test.resume");
        content.registerProjection(second);
        await content.catchUp(second.name);
        expect(first.seen).toEqual([1, 2]);
        expect(second.seen).toEqual([3, 4]);
      },
    },
    {
      name: "rebuild resets a projection and replays the whole log",
      async check({ content }) {
        const projection = recorder("test.rebuild");
        content.registerProjection(projection);
        await appendEvents(content, 3);
        await content.catchUp(projection.name);
        await content.rebuild(projection.name);
        expect(projection.resets).toBe(1);
        expect(projection.seen).toEqual([1, 2, 3]);
      },
    },
    {
      name: "a failed apply rejects catchUp, and a later catchUp retries from that entry",
      async check({ content }) {
        let isBroken = true;
        const projection = recorder(
          "test.flaky",
          (entry) => isBroken && entry.seq === 2,
        );
        content.registerProjection(projection);
        await appendEvents(content, 3);
        await expectToReject(() => content.catchUp(projection.name));
        expect(projection.seen).toEqual([1]);
        isBroken = false;
        await content.catchUp(projection.name);
        expect(projection.seen).toEqual([1, 2, 3]);
      },
    },
    {
      name: "catchUp and rebuild reject for a projection that is not registered",
      async check({ content }) {
        await expectToReject(() => content.catchUp("test.missing"));
        await expectToReject(() => content.rebuild("test.missing"));
      },
    },
  ],
);
