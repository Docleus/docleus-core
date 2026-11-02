import { DocleusError, type Context } from "@docleus/kernel";
import {
  MAIN_BRANCH,
  PAGE_ENTRY_TYPE,
  REVISION_COMMITTED,
  trackCaller,
  type Branch,
  type CommitInput,
  type ContentService,
  type Entry,
  type EntryContent,
  type EntryTypeDefinition,
  type InstallationsService,
  type LogEntry,
  type Org,
  type PreCommitInput,
  type Revision,
  type RevisionCommitted,
  type Space,
} from "@docleus/sdk";
import { sql, type Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  hashContent,
  parseEntryContent,
  revisionEntriesSchema,
} from "./entry.ts";
import { mergeEntrySets } from "./merge.ts";
import { createProjectionRunner } from "./projections.ts";
import {
  contentMigrations,
  type BranchesTable,
  type ContentSchema,
  type RevisionsTable,
} from "./schema.ts";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BRANCH_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
/** Stays well under SQLite's bound-parameter limit. */
const HASHES_PER_QUERY = 500;

function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new DocleusError("content/invalid-slug", `invalid slug "${slug}"`);
  }
}

/** What the `content/pre-commit` chain resolved to; listeners are plugins, so it is checked like input. */
const preCommitResultSchema = z.object({
  commit: z.object({
    spaceId: z.string(),
    branch: z.string(),
    parent: z.string().optional(),
    put: z.record(z.string(), z.unknown()).optional(),
    remove: z.array(z.string()).optional(),
    message: z.string(),
    author: z.string().optional(),
    merged: z.string().optional(),
    rebase: z.string().optional(),
  }),
});

type ResolvedCommit = z.output<typeof preCommitResultSchema>["commit"];

// SQLite reports unique violations only in the message; Postgres through
// SQLSTATE 23505 on the driver's error.
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "23505") return true;
  return /UNIQUE constraint failed/.test(error.message);
}

function toSpace(row: {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
}): Space {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
  };
}

function orgNotFound(id: string): DocleusError {
  return new DocleusError(
    "content/org-not-found",
    `org "${id}" does not exist`,
  );
}

/** `update` without the keys that hold `undefined`. */
function definedOf<T extends object>(update: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function uniqueSlug<T>(
  what: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new DocleusError("content/slug-taken", `${what} is already taken`, {
      cause: error,
    });
  }
}

/** A deleted row keeps its slug out of the unique index this way. */
const freedSlug = (slug: string, id: string) => `${slug}~${id}`;

function toLogEntry(row: {
  seq: number;
  type: string;
  payload: string;
  at: number;
}): LogEntry {
  return {
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    at: row.at,
  };
}

function toRevision(row: RevisionsTable): Revision {
  const entries = revisionEntriesSchema.safeParse(JSON.parse(row.entries));
  if (!entries.success) {
    throw new DocleusError(
      "content/corrupt-revision",
      `revision "${row.id}" has an invalid entry map`,
    );
  }
  return {
    id: row.id,
    spaceId: row.space_id,
    branch: row.branch,
    parent: row.parent ?? undefined,
    entries: entries.data,
    message: row.message,
    author: row.author ?? undefined,
    merged: row.merged ?? undefined,
    at: row.at,
  };
}

function toBranch(row: BranchesTable): Branch {
  return {
    spaceId: row.space_id,
    name: row.name,
    head: row.head ?? undefined,
    base: row.base ?? undefined,
    createdAt: row.created_at,
  };
}

function branchNotFound(spaceId: string, name: string): DocleusError {
  return new DocleusError(
    "content/branch-not-found",
    `space "${spaceId}" has no branch "${name}"`,
  );
}

/** Whether `id` is a revision of `main` in `spaceId`. */
async function isMainRevision(
  executor: Kysely<ContentSchema>,
  spaceId: string,
  id: string,
): Promise<boolean> {
  const row = await executor
    .selectFrom("revisions")
    .select("id")
    .where("id", "=", id)
    .where("space_id", "=", spaceId)
    .where("branch", "=", MAIN_BRANCH)
    .executeTakeFirst();
  return row !== undefined;
}

async function appendIn(
  executor: Kysely<ContentSchema>,
  type: string,
  payload: unknown,
): Promise<LogEntry> {
  const serialized = JSON.stringify(payload) as string | undefined;
  if (serialized === undefined) {
    throw new DocleusError(
      "content/invalid-payload",
      `payload of "${type}" is not JSON-serializable`,
    );
  }
  // Computing the next seq inside the INSERT keeps it gapless; callers run
  // it inside `ctx.storage.transaction`, which serializes writers on every
  // dialect (on Postgres, concurrent statements would read the same max).
  const row = await executor
    .insertInto("content_log")
    .columns(["seq", "type", "payload", "at"])
    .expression(
      executor
        .selectFrom("content_log")
        .select([
          sql<number>`coalesce(max(seq), 0) + 1`.as("seq"),
          sql<string>`${type}`.as("type"),
          sql<string>`${serialized}`.as("payload"),
          sql<number>`${Date.now()}`.as("at"),
        ]),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toLogEntry(row);
}

/** Stored contents by hash; storage is validated on the way out like any other input. */
async function loadContents(
  executor: Kysely<ContentSchema>,
  hashes: Iterable<string>,
): Promise<Map<string, EntryContent>> {
  const unique = [...new Set(hashes)];
  const contents = new Map<string, EntryContent>();
  for (let at = 0; at < unique.length; at += HASHES_PER_QUERY) {
    const rows = await executor
      .selectFrom("entry_contents")
      .selectAll()
      .where("hash", "in", unique.slice(at, at + HASHES_PER_QUERY))
      .execute();
    for (const row of rows) {
      contents.set(
        row.hash,
        parseEntryContent(
          JSON.parse(row.json),
          "content/corrupt-entry",
          `stored entry content ${row.hash}`,
        ),
      );
    }
  }
  for (const hash of unique) {
    if (!contents.has(hash)) {
      throw new DocleusError(
        "content/corrupt-entry",
        `entry content ${hash} is missing from storage`,
      );
    }
  }
  return contents;
}

/** Rejects parents that are missing from the revision and parent cycles. */
function assertTree(contents: ReadonlyMap<string, EntryContent>): void {
  for (const [id, content] of contents) {
    const seen = new Set([id]);
    let parent = content.parent;
    while (parent !== undefined) {
      const next = contents.get(parent);
      if (!next) {
        throw new DocleusError(
          "content/invalid-commit",
          `entry "${id}" has parent "${parent}", which is not in the revision`,
        );
      }
      if (seen.has(parent)) {
        throw new DocleusError(
          "content/invalid-commit",
          `entry "${id}" is its own ancestor`,
        );
      }
      seen.add(parent);
      parent = next.parent;
    }
  }
}
/**
 * Default `content` implementation on top of `ctx.storage`: organizations,
 * spaces, the append-only content log, revisions and projections. Entry
 * bodies are migrated through `ctx.blocks`. Each append emits
 * `content/log-appended` once the entry is durable.
 *
 * @stability experimental
 */
export function createContentService(ctx: Context): ContentService {
  const db = ctx.storage.db as unknown as Kysely<ContentSchema>;
  const ready = ctx.storage.migrate("@docleus/core-content", contentMigrations);
  const entryTypes = new Map<string, EntryTypeDefinition>([
    [PAGE_ENTRY_TYPE, { hasBody: true }],
  ]);

  const projections = createProjectionRunner(ctx, {
    async readCursor(name) {
      await ready;
      const row = await db
        .selectFrom("projection_cursors")
        .select("seq")
        .where("name", "=", name)
        .executeTakeFirst();
      return row?.seq ?? 0;
    },
    async writeCursor(name, seq) {
      await db
        .insertInto("projection_cursors")
        .values({ name, seq })
        .onConflict((oc) => oc.column("name").doUpdateSet({ seq }))
        .execute();
    },
    readLog: (afterSeq, limit) => readLog({ afterSeq, limit }),
  });

  function appended(entry: LogEntry): void {
    ctx.emit("content/log-appended", entry);
    projections.notify();
  }
  async function getOrg(id: string): Promise<Org | undefined> {
    await ready;
    return db
      .selectFrom("orgs")
      .select(["id", "slug", "name"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }

  async function readLog({
    afterSeq = 0,
    limit,
  }: { afterSeq?: number; limit?: number } = {}): Promise<LogEntry[]> {
    await ready;
    let query = db
      .selectFrom("content_log")
      .selectAll()
      .where("seq", ">", afterSeq)
      .orderBy("seq");
    if (limit !== undefined) query = query.limit(limit);
    const rows = await query.execute();
    return rows.map(toLogEntry);
  }

  async function getRevision(id: string): Promise<Revision | undefined> {
    await ready;
    const row = await db
      .selectFrom("revisions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row && toRevision(row);
  }

  async function head(
    spaceId: string,
    branch: string = MAIN_BRANCH,
  ): Promise<Revision | undefined> {
    await ready;
    const row = await db
      .selectFrom("branches")
      .innerJoin("revisions", "revisions.id", "branches.head")
      .selectAll("revisions")
      .where("branches.space_id", "=", spaceId)
      .where("branches.name", "=", branch)
      .executeTakeFirst();
    return row && toRevision(row);
  }

  async function heads(
    spaceIds: readonly string[],
    branch: string = MAIN_BRANCH,
  ): Promise<(Revision | undefined)[]> {
    await ready;
    if (spaceIds.length === 0) return [];
    const rows = await db
      .selectFrom("branches")
      .innerJoin("revisions", "revisions.id", "branches.head")
      .selectAll("revisions")
      .where("branches.space_id", "in", [...spaceIds])
      .where("branches.name", "=", branch)
      .execute();
    const bySpace = new Map(rows.map((row) => [row.space_id, toRevision(row)]));
    return spaceIds.map((spaceId) => bySpace.get(spaceId));
  }

  async function getSpace(spaceId: string): Promise<Space> {
    await ready;
    const row = await db
      .selectFrom("spaces")
      .selectAll()
      .where("id", "=", spaceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) {
      throw new DocleusError(
        "content/space-not-found",
        `space "${spaceId}" does not exist`,
      );
    }
    return toSpace(row);
  }

  async function getBranch(
    spaceId: string,
    name: string,
  ): Promise<Branch | undefined> {
    await ready;
    const row = await db
      .selectFrom("branches")
      .selectAll()
      .where("space_id", "=", spaceId)
      .where("name", "=", name)
      .executeTakeFirst();
    return row && toBranch(row);
  }

  /** The content with its body migrated to current block versions. */
  function migrated(content: EntryContent): EntryContent {
    return content.body
      ? { ...content, body: ctx.blocks.read(content.body) }
      : content;
  }

  function prepare(id: string, value: unknown): EntryContent {
    if (id === "") {
      throw new DocleusError(
        "content/invalid-commit",
        "entry ids must not be empty",
      );
    }
    const content = parseEntryContent(
      value,
      "content/invalid-entry",
      `entry "${id}"`,
    );
    const definition = entryTypes.get(content.type);
    if (!definition) {
      throw new DocleusError(
        "content/unknown-entry-type",
        `entry "${id}" has unknown type "${content.type}"`,
      );
    }
    const fields = definition.fields?.safeParse(content.fields);
    if (fields && !fields.success) {
      throw new DocleusError(
        "content/invalid-entry",
        `entry "${id}" has invalid fields: ${fields.error.message}`,
      );
    }
    if (definition.hasBody !== (content.body !== undefined)) {
      throw new DocleusError(
        "content/invalid-entry",
        definition.hasBody
          ? `entry "${id}" of type "${content.type}" needs a body`
          : `entry "${id}" of type "${content.type}" has no body`,
      );
    }
    if (content.body && content.body.type !== "doc") {
      throw new DocleusError(
        "content/invalid-entry",
        `entry "${id}" has a body of type "${content.body.type}", not "doc"`,
      );
    }
    return migrated(content);
  }
  /** Runs `content/pre-commit` in the space's scope and checks what it resolved to. */
  async function preCommit(
    input: CommitInput,
    isDryRun = false,
  ): Promise<ResolvedCommit> {
    const space = await getSpace(input.spaceId);
    const hookInput: PreCommitInput = {
      space,
      commit: { ...input, branch: input.branch ?? MAIN_BRANCH },
      ...(isDryRun && { isDryRun }),
    };
    const inner = async (): Promise<PreCommitInput> => hookInput;
    const installations = ctx.get("installations") as
      InstallationsService | undefined;
    const resolved: unknown = installations
      ? await ctx.waterfall(
          await installations.scope({
            kind: "space",
            orgId: space.orgId,
            spaceId: space.id,
          }),
          "content/pre-commit",
          hookInput,
          inner,
        )
      : await ctx.waterfall("content/pre-commit", hookInput, inner);
    const result = preCommitResultSchema.safeParse(resolved);
    if (!result.success) {
      throw new DocleusError(
        "content/invalid-commit",
        `content/pre-commit resolved to an invalid commit: ${result.error.message}`,
      );
    }
    if (result.data.commit.spaceId !== input.spaceId) {
      throw new DocleusError(
        "content/invalid-commit",
        `content/pre-commit moved a commit from space "${input.spaceId}" to "${result.data.commit.spaceId}"`,
      );
    }
    return result.data.commit;
  }

  async function commit(input: CommitInput): Promise<Revision> {
    await ready;
    const resolved = await preCommit(input);
    return write(resolved);
  }

  async function checkCommit(input: CommitInput): Promise<void> {
    await ready;
    await preCommit(input, true);
  }

  async function write(input: ResolvedCommit): Promise<Revision> {
    const { spaceId, branch } = input;
    const removed = [...new Set(input.remove ?? [])];
    const prepared = new Map(
      Object.entries(input.put ?? {}).map(([id, value]) => [
        id,
        prepare(id, value),
      ]),
    );
    for (const id of removed) {
      if (prepared.has(id)) {
        throw new DocleusError(
          "content/invalid-commit",
          `entry "${id}" is both put and removed`,
        );
      }
    }
    if (input.rebase !== undefined && branch === MAIN_BRANCH) {
      throw new DocleusError(
        "content/invalid-commit",
        `"${MAIN_BRANCH}" cannot be rebased`,
      );
    }
    const committed = await ctx.storage.transaction(async (trx) => {
      const t = trx as unknown as Kysely<ContentSchema>;
      const target = await t
        .selectFrom("branches")
        .select("head")
        .where("space_id", "=", spaceId)
        .where("name", "=", branch)
        .executeTakeFirst();
      if (!target) throw branchNotFound(spaceId, branch);
      if (
        input.rebase !== undefined &&
        !(await isMainRevision(t, spaceId, input.rebase))
      ) {
        throw new DocleusError(
          "content/invalid-commit",
          `rebase target "${input.rebase}" is not a revision of "${MAIN_BRANCH}" in space "${spaceId}"`,
        );
      }
      if (input.merged !== undefined) {
        const merged = await t
          .selectFrom("revisions")
          .select("id")
          .where("id", "=", input.merged)
          .where("space_id", "=", spaceId)
          .executeTakeFirst();
        if (!merged) {
          throw new DocleusError(
            "content/invalid-commit",
            `merged revision "${input.merged}" is not in space "${spaceId}"`,
          );
        }
      }
      const current =
        target.head === null
          ? undefined
          : await t
              .selectFrom("revisions")
              .selectAll()
              .where("id", "=", target.head)
              .executeTakeFirstOrThrow();
      if (current?.id !== input.parent) {
        throw new DocleusError(
          "content/stale-head",
          `commit is based on ${input.parent ?? "no revision"}, but the head of branch "${branch}" in space "${spaceId}" is ${current?.id ?? "empty"}`,
        );
      }

      const entries = new Map(
        Object.entries(current ? toRevision(current).entries : {}),
      );
      for (const id of removed) {
        if (!entries.delete(id)) {
          throw new DocleusError(
            "content/entry-not-found",
            `entry "${id}" is not in revision ${input.parent ?? "(none)"}`,
          );
        }
      }
      const changed: string[] = [];
      const known = new Map<string, EntryContent>();
      for (const [id, content] of prepared) {
        const { hash, json } = hashContent(content);
        known.set(hash, content);
        if (entries.get(id) === hash) continue;
        entries.set(id, hash);
        changed.push(id);
        await t
          .insertInto("entry_contents")
          .values({ hash, json })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();
      }

      const stored = await loadContents(
        t,
        [...entries.values()].filter((hash) => !known.has(hash)),
      );
      assertTree(
        new Map(
          [...entries].map(([id, hash]) => [
            id,
            known.get(hash) ?? stored.get(hash) ?? throwMissing(hash),
          ]),
        ),
      );

      const revision: Revision = {
        id: uuidv7(),
        spaceId,
        branch,
        parent: input.parent,
        entries: Object.fromEntries(
          [...entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        message: input.message,
        author: input.author,
        merged: input.merged,
        at: Date.now(),
      };
      await t
        .insertInto("revisions")
        .values({
          id: revision.id,
          space_id: revision.spaceId,
          branch,
          parent: revision.parent ?? null,
          entries: JSON.stringify(revision.entries),
          message: revision.message,
          author: revision.author ?? null,
          merged: revision.merged ?? null,
          at: revision.at,
        })
        .execute();
      await t
        .updateTable("branches")
        .set({
          head: revision.id,
          ...(input.rebase !== undefined && { base: input.rebase }),
        })
        .where("space_id", "=", spaceId)
        .where("name", "=", branch)
        .execute();
      const payload: RevisionCommitted = {
        spaceId,
        revision: revision.id,
        parent: revision.parent,
        branch,
        changed: changed.toSorted(),
        removed: removed.toSorted(),
      };
      const logEntry = await appendIn(t, REVISION_COMMITTED, payload);
      return { revision, logEntry };
    });
    appended(committed.logEntry);
    return committed.revision;
  }

  async function listEntries(revisionId: string): Promise<Entry[]> {
    const revision = await getRevision(revisionId);
    if (!revision) {
      throw new DocleusError(
        "content/revision-not-found",
        `revision "${revisionId}" does not exist`,
      );
    }
    const contents = await loadContents(db, Object.values(revision.entries));
    return Object.entries(revision.entries).map(([id, hash]) => ({
      id,
      ...migrated(contents.get(hash) ?? throwMissing(hash)),
    }));
  }
  return trackCaller<ContentService>(ctx, {
    async createOrg({ slug, name }) {
      assertSlug(slug);
      await ready;
      const org = { id: uuidv7(), slug, name };
      try {
        await db
          .insertInto("orgs")
          .values({ ...org, deleted_at: null })
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new DocleusError(
          "content/slug-taken",
          `org slug "${slug}" is already taken`,
          { cause: error },
        );
      }
      return org;
    },
    getOrg,
    async listOrgs() {
      await ready;
      return db
        .selectFrom("orgs")
        .select(["id", "slug", "name"])
        .where("deleted_at", "is", null)
        .orderBy("id")
        .execute();
    },
    async createSpace({ orgId, slug, name, description = "" }) {
      assertSlug(slug);
      if (!(await getOrg(orgId))) {
        throw new DocleusError(
          "content/org-not-found",
          `org "${orgId}" does not exist`,
        );
      }
      const row = {
        id: uuidv7(),
        org_id: orgId,
        slug,
        name,
        description,
        deleted_at: null,
      };
      try {
        await ctx.storage.transaction(async (trx) => {
          const t = trx as unknown as Kysely<ContentSchema>;
          await t.insertInto("spaces").values(row).execute();
          await t
            .insertInto("branches")
            .values({
              space_id: row.id,
              name: MAIN_BRANCH,
              head: null,
              base: null,
              created_at: Date.now(),
            })
            .execute();
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new DocleusError(
          "content/slug-taken",
          `space slug "${slug}" is already taken in org "${orgId}"`,
          { cause: error },
        );
      }
      return toSpace(row);
    },
    async listSpaces(orgId) {
      await ready;
      const rows = await db
        .selectFrom("spaces")
        .selectAll()
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .orderBy("id")
        .execute();
      return rows.map(toSpace);
    },
    async updateOrg(id, update) {
      if (update.slug !== undefined) assertSlug(update.slug);
      const before = await getOrg(id);
      if (!before) throw orgNotFound(id);
      const org = { ...before, ...definedOf(update) };
      const entry = await uniqueSlug(`org slug "${org.slug}"`, () =>
        ctx.storage.transaction(async (trx) => {
          const t = trx as unknown as Kysely<ContentSchema>;
          await t
            .updateTable("orgs")
            .set({ slug: org.slug, name: org.name })
            .where("id", "=", id)
            .execute();
          return appendIn(t, "org/updated", { org });
        }),
      );
      appended(entry);
      return org;
    },
    async deleteOrg(id) {
      const org = await getOrg(id);
      if (!org) throw orgNotFound(id);
      const spaces = await db
        .selectFrom("spaces")
        .selectAll()
        .where("org_id", "=", id)
        .where("deleted_at", "is", null)
        .execute();
      const entries = await ctx.storage.transaction(async (trx) => {
        const t = trx as unknown as Kysely<ContentSchema>;
        const at = Date.now();
        const out: LogEntry[] = [];
        for (const space of spaces) {
          await t
            .updateTable("spaces")
            .set({ deleted_at: at, slug: freedSlug(space.slug, space.id) })
            .where("id", "=", space.id)
            .execute();
          out.push(
            await appendIn(t, "space/deleted", {
              spaceId: space.id,
              orgId: id,
            }),
          );
        }
        await t
          .updateTable("orgs")
          .set({ deleted_at: at, slug: freedSlug(org.slug, id) })
          .where("id", "=", id)
          .execute();
        out.push(await appendIn(t, "org/deleted", { orgId: id }));
        return out;
      });
      for (const entry of entries) appended(entry);
    },
    async updateSpace(id, update) {
      if (update.slug !== undefined) assertSlug(update.slug);
      const before = await getSpace(id);
      const space = { ...before, ...definedOf(update) };
      const entry = await uniqueSlug(
        `space slug "${space.slug}" in org "${space.orgId}"`,
        () =>
          ctx.storage.transaction(async (trx) => {
            const t = trx as unknown as Kysely<ContentSchema>;
            await t
              .updateTable("spaces")
              .set({
                slug: space.slug,
                name: space.name,
                description: space.description,
              })
              .where("id", "=", id)
              .execute();
            return appendIn(t, "space/updated", { space });
          }),
      );
      appended(entry);
      return space;
    },
    async deleteSpace(id) {
      const space = await getSpace(id);
      const entry = await ctx.storage.transaction(async (trx) => {
        const t = trx as unknown as Kysely<ContentSchema>;
        await t
          .updateTable("spaces")
          .set({ deleted_at: Date.now(), slug: freedSlug(space.slug, id) })
          .where("id", "=", id)
          .execute();
        return appendIn(t, "space/deleted", {
          spaceId: id,
          orgId: space.orgId,
        });
      });
      appended(entry);
    },
    async append(type, payload) {
      await ready;
      const entry = await ctx.storage.transaction((trx) =>
        appendIn(trx as unknown as Kysely<ContentSchema>, type, payload),
      );
      appended(entry);
      return entry;
    },
    readLog,

    registerEntryType(type, definition) {
      return this.ctx.effect(
        () => {
          if (entryTypes.has(type)) {
            throw new DocleusError(
              "content/entry-type-taken",
              `entry type "${type}" is already registered`,
            );
          }
          entryTypes.set(type, definition);
          return () => {
            if (entryTypes.get(type) === definition) entryTypes.delete(type);
          };
        },
        `ctx.content.registerEntryType(${JSON.stringify(type)})`,
      );
    },
    commit,
    checkCommit,
    head,
    heads,
    async createBranch({ spaceId, name, from }) {
      if (name === MAIN_BRANCH || !BRANCH_PATTERN.test(name)) {
        throw new DocleusError(
          "content/invalid-branch",
          `invalid branch name "${name}"`,
        );
      }
      await getSpace(spaceId);
      return ctx.storage.transaction(async (trx) => {
        const t = trx as unknown as Kysely<ContentSchema>;
        let start = from;
        if (start === undefined) {
          const main = await t
            .selectFrom("branches")
            .select("head")
            .where("space_id", "=", spaceId)
            .where("name", "=", MAIN_BRANCH)
            .executeTakeFirst();
          start = main?.head ?? undefined;
        } else if (!(await isMainRevision(t, spaceId, start))) {
          throw new DocleusError(
            "content/invalid-branch",
            `"${start}" is not a revision of "${MAIN_BRANCH}" in space "${spaceId}"`,
          );
        }
        const row: BranchesTable = {
          space_id: spaceId,
          name,
          head: start ?? null,
          base: start ?? null,
          created_at: Date.now(),
        };
        try {
          await t.insertInto("branches").values(row).execute();
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          throw new DocleusError(
            "content/branch-taken",
            `space "${spaceId}" already has a branch "${name}"`,
            { cause: error },
          );
        }
        return toBranch(row);
      });
    },
    getBranch,
    async listBranches(spaceId) {
      await ready;
      const rows = await db
        .selectFrom("branches")
        .selectAll()
        .where("space_id", "=", spaceId)
        .orderBy("name")
        .execute();
      return rows
        .map(toBranch)
        .toSorted(
          (a, b) =>
            Number(b.name === MAIN_BRANCH) - Number(a.name === MAIN_BRANCH),
        );
    },
    async deleteBranch(spaceId, name) {
      if (name === MAIN_BRANCH) {
        throw new DocleusError(
          "content/invalid-branch",
          `"${MAIN_BRANCH}" cannot be deleted`,
        );
      }
      await ready;
      const deleted = await db
        .deleteFrom("branches")
        .where("space_id", "=", spaceId)
        .where("name", "=", name)
        .returning("name")
        .executeTakeFirst();
      if (!deleted) throw branchNotFound(spaceId, name);
    },
    merge: (input) => mergeEntrySets(input),
    getRevision,
    async getEntry(revisionId, entryId) {
      const revision = await getRevision(revisionId);
      const hash = revision?.entries[entryId];
      if (hash === undefined) return undefined;
      const contents = await loadContents(db, [hash]);
      return {
        id: entryId,
        ...migrated(contents.get(hash) ?? throwMissing(hash)),
      };
    },
    listEntries,
    async migrate(spaceId) {
      const current = await head(spaceId);
      if (!current) return undefined;
      const put: Record<string, EntryContent> = {};
      for (const { id, ...content } of await listEntries(current.id)) {
        // Entries of a type nobody registers now cannot be validated, so
        // they are left as stored; they migrate once the type is back.
        if (!entryTypes.has(content.type)) continue;
        if (hashContent(content).hash !== current.entries[id])
          put[id] = content;
      }
      if (Object.keys(put).length === 0) return undefined;
      return commit({
        spaceId,
        parent: current.id,
        put,
        message: "Migrate blocks to their current versions",
      });
    },

    registerProjection(projection) {
      return this.ctx.effect(
        () => projections.add(projection),
        `ctx.content.registerProjection(${JSON.stringify(projection.name)})`,
      );
    },
    catchUp: (name) => projections.catchUp(name),
    rebuild: (name) => projections.rebuild(name),
  });
}

function throwMissing(hash: string): never {
  throw new DocleusError(
    "content/corrupt-entry",
    `entry content ${hash} is missing from storage`,
  );
}

export function provideContent(ctx: Context): () => void {
  return ctx.provide("content", createContentService(ctx));
}
