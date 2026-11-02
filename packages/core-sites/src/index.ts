import {
  DocleusError,
  SITE_PUBLISHED,
  type Context,
  type Publication,
  type Site,
  type SitePublished,
  type SiteRequest,
  type SitesService,
} from "@docleus/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import type { SiteAssetSource } from "./assets.ts";
import {
  NO_BLOB_CACHE,
  createBlobCache,
  type SiteCacheOptions,
} from "./blob-cache.ts";
import { buildSite } from "./build.ts";
import {
  canonicalJson,
  parseArtifact,
  parseSitePublished,
  toPublication,
  toSite,
} from "./rows.ts";
import {
  sitesMigrations,
  type SitesSchema,
  type SitesTable,
} from "./schema.ts";
import { decodePath, serveArtifact } from "./serve.ts";
import {
  assertName,
  assertSlug,
  assertSpaces,
  normalizeHost,
  parseDomain,
} from "./validate.ts";

export type { SiteAssetSource, SitePluginSource } from "./assets.ts";
export { siteBrowserRoot, pluginAssetDir, pluginSlug } from "./assets.ts";
export { normalizeHost } from "./validate.ts";
export {
  DEFAULT_SITE_CACHE_MAX_BYTES,
  type SiteCacheOptions,
} from "./blob-cache.ts";

const OWNER = "@docleus/core-sites";
const PROJECTION = "@docleus/core-sites/active";
const SPACE_DELETED = "space/deleted";
const ORG_DELETED = "org/deleted";
const deletedPayload = z.union([
  z.object({ spaceId: z.string(), orgId: z.string() }),
  z.object({ orgId: z.string(), spaceId: z.undefined().optional() }),
]);
const ARTIFACT_CACHE_SIZE = 32;

export interface SitesServiceOptions {
  /** Where the site runtime and plugin browser files are read from. */
  readonly assets: SiteAssetSource;
  /** Recorded in every publication's config snapshot. */
  readonly platformVersion: string;
  /**
   * A local disk cache of the blobs that serving reads (artifacts and
   * their files), shared across restarts and by processes on the same
   * data directory. Serving reads `blobs` directly when omitted.
   */
  readonly cache?: SiteCacheOptions;
}

// SQLite reports unique violations only in the message ("sites.domain");
// Postgres through SQLSTATE 23505 and the constraint name ("sites_domain_key").
function isUniqueViolation(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "23505") return true;
  return /UNIQUE constraint failed/.test(error.message);
}

function isDomainViolation(error: Error): boolean {
  if ("constraint" in error) return error.constraint === "sites_domain_key";
  return error.message.includes("sites.domain");
}

function siteNotFound(id: string): DocleusError {
  return new DocleusError("sites/not-found", `site "${id}" does not exist`);
}

function uniqueError(error: Error, site: Pick<Site, "slug" | "domain">) {
  return isDomainViolation(error)
    ? new DocleusError(
        "sites/domain-taken",
        `domain "${site.domain ?? ""}" is already used by another site`,
        { cause: error },
      )
    : new DocleusError(
        "sites/slug-taken",
        `site slug "${site.slug}" is already taken in this org`,
        { cause: error },
      );
}

function toRow(site: Site): SitesTable {
  return {
    id: site.id,
    org_id: site.orgId,
    slug: site.slug,
    name: site.name,
    theme: site.theme ?? null,
    domain: site.domain ?? null,
    spaces: JSON.stringify(
      site.spaces.map(({ spaceId, path }) => ({ spaceId, path })),
    ),
  };
}

/**
 * Default `sites` implementation: sites and publications in `ctx.storage`,
 * artifacts in `ctx.blobs`, the active publication as a projection over
 * the `site/published` content-log entries. Needs `storage`, `blobs`,
 * `content`, `installations` and `render` on `ctx`.
 *
 * @stability experimental
 */
export function createSitesService(
  ctx: Context,
  options: SitesServiceOptions,
): SitesService {
  const db = ctx.storage.db as unknown as Kysely<SitesSchema>;
  const ready = ctx.storage.migrate(OWNER, sitesMigrations);
  const logger = ctx.logger("sites");
  const queues = new Map<string, Promise<void>>();
  const artifacts = new Map<string, ReturnType<typeof parseArtifact>>();
  const cache = options.cache
    ? createBlobCache(options.cache, logger)
    : NO_BLOB_CACHE;
  const readBlob = (hash: string) =>
    cache.read(hash, (key) => ctx.blobs.get(key));

  // A site goes with the space it starts from, or with its org; other sites
  // drop the deleted space. Replays find nothing left to do.
  async function forgetDeleted(payload: unknown): Promise<void> {
    const parsed = deletedPayload.safeParse(payload);
    if (!parsed.success) return;
    const { spaceId, orgId } = parsed.data;
    await ready;
    const rows = await db
      .selectFrom("sites")
      .selectAll()
      .$if(orgId !== undefined, (query) =>
        query.where("org_id", "=", orgId ?? ""),
      )
      .execute();
    for (const row of rows) {
      const site = toSite(row, undefined);
      const isGone =
        spaceId === undefined || site.spaces[0]?.spaceId === spaceId;
      if (isGone) {
        await removeSite(site.id);
      } else if (site.spaces.some((each) => each.spaceId === spaceId)) {
        const spaces = site.spaces.filter((each) => each.spaceId !== spaceId);
        await db
          .updateTable("sites")
          .set(toRow({ ...site, spaces }))
          .where("id", "=", site.id)
          .execute();
      }
    }
  }

  async function removeSite(id: string): Promise<void> {
    await ctx.storage.transaction(async (trx) => {
      const t = trx as unknown as Kysely<SitesSchema>;
      await t.deleteFrom("site_active").where("site_id", "=", id).execute();
      await t
        .deleteFrom("site_publications")
        .where("site_id", "=", id)
        .execute();
      await t.deleteFrom("sites").where("id", "=", id).execute();
    });
  }

  ctx.content.registerProjection({
    name: PROJECTION,
    async reset() {
      await ready;
      await db.deleteFrom("site_active").execute();
    },
    async apply(entry) {
      if (entry.type === SPACE_DELETED || entry.type === ORG_DELETED) {
        await forgetDeleted(entry.payload);
        return;
      }
      if (entry.type !== SITE_PUBLISHED) return;
      const payload = parseSitePublished(entry.payload);
      if (!payload) {
        logger.warn(
          "ignoring an invalid %s entry %d",
          SITE_PUBLISHED,
          entry.seq,
        );
        return;
      }
      await ready;
      const publication = await db
        .selectFrom("site_publications")
        .select("id")
        .where("id", "=", payload.publication)
        .where("site_id", "=", payload.siteId)
        .executeTakeFirst();
      if (!publication) return;
      await db
        .insertInto("site_active")
        .values({ site_id: payload.siteId, publication_id: publication.id })
        .onConflict((oc) =>
          oc.column("site_id").doUpdateSet({ publication_id: publication.id }),
        )
        .execute();
    },
  });

  // Publications keep their artifacts, and artifacts their files. A blob
  // that a publish is still writing has no row yet; the collector's grace
  // period keeps it.
  ctx.on("blobs/mark", async ({ mark }) => {
    await ready;
    const rows = await db
      .selectFrom("site_publications")
      .select("artifact")
      .distinct()
      .execute();
    for (const { artifact: hash } of rows) {
      mark(hash);
      const bytes = await ctx.blobs.get(hash);
      if (!bytes) continue;
      let artifact: ReturnType<typeof parseArtifact>;
      try {
        artifact = parseArtifact(bytes, hash);
      } catch (error) {
        logger.warn("cannot mark the files of artifact %s: %s", hash, error);
        continue;
      }
      for (const file of Object.values(artifact.files)) mark(file.hash);
    }
  });

  function serialized<T>(siteId: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(siteId) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(siteId, tail);
    void tail.then(() => {
      if (queues.get(siteId) === tail) queues.delete(siteId);
    });
    return run;
  }

  async function get(id: string): Promise<Site | undefined> {
    await ready;
    const row = await db
      .selectFrom("sites")
      .leftJoin("site_active", "site_active.site_id", "sites.id")
      .selectAll("sites")
      .select("site_active.publication_id")
      .where("sites.id", "=", id)
      .executeTakeFirst();
    return row && toSite(row, row.publication_id);
  }

  async function requireSite(id: string): Promise<Site> {
    const site = await get(id);
    if (!site) throw siteNotFound(id);
    return site;
  }

  async function getPublication(id: string): Promise<Publication | undefined> {
    await ready;
    const row = await db
      .selectFrom("site_publications")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row && toPublication(row);
  }

  async function assertSpacesOf(
    orgId: string,
    spaces: Site["spaces"],
  ): Promise<void> {
    assertSpaces(spaces);
    const known = new Set(
      (await ctx.content.listSpaces(orgId)).map((space) => space.id),
    );
    for (const { spaceId } of spaces) {
      if (!known.has(spaceId)) {
        throw new DocleusError(
          "sites/invalid-spaces",
          `space "${spaceId}" does not exist in org "${orgId}"`,
        );
      }
    }
  }

  async function activateNow(
    siteId: string,
    publication: Publication,
    rollback: boolean,
    by: string | undefined,
  ): Promise<void> {
    const payload: SitePublished = {
      siteId,
      publication: publication.id,
      artifact: publication.artifact,
      rollback,
      by,
    };
    await ctx.content.append(SITE_PUBLISHED, payload);
    await ctx.content.catchUp(PROJECTION);
  }

  async function readArtifact(hash: string) {
    const cached = artifacts.get(hash);
    if (cached) return cached;
    const bytes = await readBlob(hash);
    if (!bytes) {
      throw new DocleusError(
        "sites/artifact-not-found",
        `artifact ${hash} is missing from blob storage`,
      );
    }
    const artifact = parseArtifact(bytes, hash);
    if (artifacts.size >= ARTIFACT_CACHE_SIZE) {
      const oldest = artifacts.keys().next();
      if (!oldest.done) artifacts.delete(oldest.value);
    }
    artifacts.set(hash, artifact);
    return artifact;
  }

  return {
    async create(input) {
      assertSlug(input.slug);
      assertName(input.name);
      const domain =
        input.domain === undefined ? undefined : parseDomain(input.domain);
      if (!(await ctx.content.getOrg(input.orgId))) {
        throw new DocleusError(
          "sites/org-not-found",
          `org "${input.orgId}" does not exist`,
        );
      }
      await assertSpacesOf(input.orgId, input.spaces);
      const site: Site = {
        id: uuidv7(),
        orgId: input.orgId,
        slug: input.slug,
        name: input.name,
        theme: input.theme,
        domain,
        spaces: input.spaces.map(({ spaceId, path }) => ({ spaceId, path })),
        active: undefined,
      };
      await ready;
      try {
        await db.insertInto("sites").values(toRow(site)).execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw uniqueError(error, site);
      }
      return site;
    },
    get,
    async list(orgId) {
      await ready;
      const rows = await db
        .selectFrom("sites")
        .leftJoin("site_active", "site_active.site_id", "sites.id")
        .selectAll("sites")
        .select("site_active.publication_id")
        .where("sites.org_id", "=", orgId)
        .orderBy("sites.id")
        .execute();
      return rows.map((row) => toSite(row, row.publication_id));
    },
    async update(id, input) {
      const current = await requireSite(id);
      if (input.slug !== undefined) assertSlug(input.slug);
      if (input.name !== undefined) assertName(input.name);
      const domain =
        input.domain === undefined
          ? current.domain
          : input.domain === null
            ? undefined
            : parseDomain(input.domain);
      if (input.spaces !== undefined) {
        await assertSpacesOf(current.orgId, input.spaces);
      }
      const next: Site = {
        ...current,
        slug: input.slug ?? current.slug,
        name: input.name ?? current.name,
        theme:
          input.theme === undefined
            ? current.theme
            : (input.theme ?? undefined),
        domain,
        spaces: input.spaces ?? current.spaces,
      };
      try {
        await db
          .updateTable("sites")
          .set(toRow(next))
          .where("id", "=", id)
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw uniqueError(error, next);
      }
      return (await get(id)) ?? next;
    },
    async remove(id) {
      await requireSite(id);
      await removeSite(id);
    },
    async findByDomain(host) {
      const domain = normalizeHost(host);
      if (domain === undefined) return undefined;
      await ready;
      const row = await db
        .selectFrom("sites")
        .select("id")
        .where("domain", "=", domain)
        .executeTakeFirst();
      return row && get(row.id);
    },
    async findBySlug(orgSlug, siteSlug) {
      const org = (await ctx.content.listOrgs()).find(
        (candidate) => candidate.slug === orgSlug,
      );
      if (!org) return undefined;
      await ready;
      const row = await db
        .selectFrom("sites")
        .select("id")
        .where("org_id", "=", org.id)
        .where("slug", "=", siteSlug)
        .executeTakeFirst();
      return row && get(row.id);
    },

    publish(siteId, publishOptions = {}) {
      return serialized(siteId, async () => {
        const site = await requireSite(siteId);
        const built = await buildSite(ctx, site, {
          assets: options.assets,
          ...(publishOptions.revisions && {
            revisions: publishOptions.revisions,
          }),
          logger,
        });
        const files: Record<
          string,
          { hash: string; type: string; size: number }
        > = {};
        for (const [path, file] of [...built.files].toSorted(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          const stat = await ctx.blobs.put(file.bytes);
          files[path] = { hash: stat.hash, type: file.type, size: stat.size };
        }
        const artifact = await ctx.blobs.put(
          new TextEncoder().encode(canonicalJson({ format: 1, files })),
        );
        const publication: Publication = {
          id: uuidv7(),
          siteId,
          artifact: artifact.hash,
          revisions: built.revisions,
          config: {
            name: site.name,
            theme: site.theme,
            themeSettings: built.themeSettings,
            spaces: site.spaces,
            platformVersion: options.platformVersion,
          },
          lockfile: built.lockfile,
          at: Date.now(),
          by: publishOptions.by,
        };
        await db
          .insertInto("site_publications")
          .values({
            id: publication.id,
            site_id: siteId,
            artifact: publication.artifact,
            revisions: canonicalJson(publication.revisions),
            config: canonicalJson(publication.config),
            lockfile: JSON.stringify(publication.lockfile),
            at: publication.at,
            by: publication.by ?? null,
          })
          .execute();
        await activateNow(siteId, publication, false, publishOptions.by);
        return publication;
      });
    },
    async listPublications(siteId) {
      await ready;
      const rows = await db
        .selectFrom("site_publications")
        .selectAll()
        .where("site_id", "=", siteId)
        .orderBy("at", "desc")
        .orderBy("id", "desc")
        .execute();
      return rows.map(toPublication);
    },
    getPublication,
    activate(siteId, publicationId, activateOptions = {}) {
      return serialized(siteId, async () => {
        await requireSite(siteId);
        const publication = await getPublication(publicationId);
        if (publication?.siteId !== siteId) {
          throw new DocleusError(
            "sites/publication-not-found",
            `site "${siteId}" has no publication "${publicationId}"`,
          );
        }
        await activateNow(siteId, publication, true, activateOptions.by);
      });
    },
    readArtifact,
    async serve(site, request, path) {
      const publication =
        site.active === undefined
          ? undefined
          : await getPublication(site.active);
      const first = site.spaces[0];
      const input: SiteRequest = {
        request,
        site,
        publication,
        path: decodePath(path) ?? path,
      };
      const inner = async (): Promise<Response> =>
        serveArtifact(request, path, {
          artifact: publication && (await readArtifact(publication.artifact)),
          readBlob,
        });
      if (!first) return ctx.waterfall("site/request", input, inner);
      const scope = await ctx.installations.scope({
        kind: "space",
        orgId: site.orgId,
        spaceId: first.spaceId,
      });
      return ctx.waterfall(scope, "site/request", input, inner);
    },
  };
}

export function provideSites(
  ctx: Context,
  options: SitesServiceOptions,
): () => void {
  return ctx.provide("sites", createSitesService(ctx, options));
}
