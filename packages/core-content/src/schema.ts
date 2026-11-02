import { sql, type Kysely } from "kysely";

export interface OrgsTable {
  id: string;
  slug: string;
  name: string;
  /** Set once deleted; the row stays so old log entries keep resolving. */
  deleted_at: number | null;
}

export interface SpacesTable {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
  deleted_at: number | null;
}

export interface ContentLogTable {
  seq: number;
  type: string;
  payload: string;
  at: number;
}

/** Entry contents by hash, shared by every revision that holds them. */
export interface EntryContentsTable {
  hash: string;
  json: string;
}

export interface RevisionsTable {
  id: string;
  space_id: string;
  parent: string | null;
  /** JSON object: entry id to content hash. */
  entries: string;
  message: string;
  branch: string;
  author: string | null;
  merged: string | null;
  at: number;
}

export interface BranchesTable {
  space_id: string;
  name: string;
  head: string | null;
  base: string | null;
  created_at: number;
}

export interface ProjectionCursorsTable {
  name: string;
  seq: number;
}

export interface ContentSchema {
  orgs: OrgsTable;
  spaces: SpacesTable;
  content_log: ContentLogTable;
  entry_contents: EntryContentsTable;
  revisions: RevisionsTable;
  branches: BranchesTable;
  projection_cursors: ProjectionCursorsTable;
}

export const contentMigrations = [
  {
    id: "0001-create-tables",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<ContentSchema>;
      await typed.schema
        .createTable("orgs")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("slug", "text", (c) => c.notNull().unique())
        .addColumn("name", "text", (c) => c.notNull())
        .execute();
      await typed.schema
        .createTable("spaces")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
        .addColumn("slug", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addUniqueConstraint("spaces_org_id_slug", ["org_id", "slug"])
        .execute();
      await typed.schema
        .createTable("content_log")
        .ifNotExists()
        .addColumn("seq", "integer", (c) => c.primaryKey())
        .addColumn("type", "text", (c) => c.notNull())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("at", "integer", (c) => c.notNull())
        .execute();
    },
  },
  {
    id: "0002-create-revisions",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<ContentSchema>;
      await typed.schema
        .createTable("entry_contents")
        .addColumn("hash", "text", (c) => c.primaryKey())
        .addColumn("json", "text", (c) => c.notNull())
        .execute();
      await typed.schema
        .createTable("revisions")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("space_id", "text", (c) =>
          c.notNull().references("spaces.id"),
        )
        .addColumn("parent", "text", (c) => c.references("revisions.id"))
        .addColumn("entries", "text", (c) => c.notNull())
        .addColumn("message", "text", (c) => c.notNull())
        .addColumn("at", "integer", (c) => c.notNull())
        .execute();
      await typed.schema
        .createTable("space_heads")
        .addColumn("space_id", "text", (c) =>
          c.primaryKey().references("spaces.id"),
        )
        .addColumn("revision_id", "text", (c) =>
          c.notNull().references("revisions.id"),
        )
        .execute();
      await typed.schema
        .createTable("projection_cursors")
        .addColumn("name", "text", (c) => c.primaryKey())
        .addColumn("seq", "integer", (c) => c.notNull())
        .execute();
    },
  },
  {
    id: "0003-branches",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<ContentSchema>;
      await typed.schema
        .createTable("branches")
        .addColumn("space_id", "text", (c) =>
          c.notNull().references("spaces.id"),
        )
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("head", "text", (c) => c.references("revisions.id"))
        .addColumn("base", "text", (c) => c.references("revisions.id"))
        .addColumn("created_at", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint("branches_pk", ["space_id", "name"])
        .execute();
      await typed.schema
        .alterTable("revisions")
        .addColumn("branch", "text", (c) => c.notNull().defaultTo("main"))
        .execute();
      await typed.schema
        .alterTable("revisions")
        .addColumn("author", "text")
        .execute();
      await typed.schema
        .alterTable("revisions")
        .addColumn("merged", "text")
        .execute();
      await sql`
        insert into branches (space_id, name, head, base, created_at)
        select spaces.id, 'main', space_heads.revision_id, null,
          coalesce(
            (select min(at) from revisions where revisions.space_id = spaces.id),
            ${Date.now()}
          )
        from spaces left join space_heads on space_heads.space_id = spaces.id
      `.execute(db);
      await typed.schema.dropTable("space_heads").execute();
    },
  },
  {
    id: "0004-update-and-delete",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<ContentSchema>;
      await typed.schema
        .alterTable("orgs")
        .addColumn("deleted_at", "integer")
        .execute();
      await typed.schema
        .alterTable("spaces")
        .addColumn("description", "text", (c) => c.notNull().defaultTo(""))
        .execute();
      await typed.schema
        .alterTable("spaces")
        .addColumn("deleted_at", "integer")
        .execute();
    },
  },
];
