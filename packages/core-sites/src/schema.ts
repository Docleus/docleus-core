import type { Kysely } from "kysely";

export interface SitesTable {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  theme: string | null;
  domain: string | null;
  /** JSON array of `SiteSpace`. */
  spaces: string;
}

export interface PublicationsTable {
  id: string;
  site_id: string;
  artifact: string;
  /** JSON object: space id to revision id. */
  revisions: string;
  /** JSON `SiteConfigSnapshot`. */
  config: string;
  /** JSON array of `PluginLock`. */
  lockfile: string;
  at: number;
  by: string | null;
}

/** The projection of `site/published`: the publication each site serves. */
export interface ActiveTable {
  site_id: string;
  publication_id: string;
}

export interface SitesSchema {
  sites: SitesTable;
  site_publications: PublicationsTable;
  site_active: ActiveTable;
}

export const sitesMigrations = [
  {
    id: "0001-create-tables",
    async up(db: Kysely<unknown>) {
      const typed = db as unknown as Kysely<SitesSchema>;
      await typed.schema
        .createTable("sites")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("org_id", "text", (c) => c.notNull())
        .addColumn("slug", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("theme", "text")
        .addColumn("domain", "text", (c) => c.unique())
        .addColumn("spaces", "text", (c) => c.notNull())
        .addUniqueConstraint("sites_org_id_slug", ["org_id", "slug"])
        .execute();
      await typed.schema
        .createTable("site_publications")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("site_id", "text", (c) => c.notNull())
        .addColumn("artifact", "text", (c) => c.notNull())
        .addColumn("revisions", "text", (c) => c.notNull())
        .addColumn("config", "text", (c) => c.notNull())
        .addColumn("lockfile", "text", (c) => c.notNull())
        .addColumn("at", "integer", (c) => c.notNull())
        .addColumn("by", "text")
        .execute();
      await typed.schema
        .createIndex("site_publications_site_id")
        .on("site_publications")
        .columns(["site_id", "at", "id"])
        .execute();
      await typed.schema
        .createTable("site_active")
        .addColumn("site_id", "text", (c) => c.primaryKey())
        .addColumn("publication_id", "text", (c) => c.notNull())
        .execute();
    },
  },
];
