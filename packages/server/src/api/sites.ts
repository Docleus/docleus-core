import { DocleusError, type Context } from "@docleus/kernel";
import type { HttpRequestContext, Revision, Site } from "@docleus/sdk";
import { z } from "zod";
import {
  assertCan,
  handle,
  json,
  param,
  readBody,
  requireSpace,
} from "./respond.ts";

const SITES = "/api/orgs/:orgId/sites";
const SITE = `${SITES}/:siteId`;

const siteSpaces = z.array(
  z.object({ spaceId: z.string().min(1), path: z.string() }),
);

const createSiteBody = z.object({
  slug: z.string(),
  name: z.string(),
  spaces: siteSpaces,
  theme: z.string().min(1).optional(),
  domain: z.string().optional(),
});

const updateSiteBody = z.object({
  slug: z.string().optional(),
  name: z.string().optional(),
  theme: z.string().min(1).nullable().optional(),
  domain: z.string().nullable().optional(),
  spaces: siteSpaces.optional(),
});

const activateBody = z.object({ publication: z.string().min(1) });

/** The URL a site is served at on this instance. */
export function siteUrl(orgSlug: string, siteSlug: string): string {
  return `/sites/${encodeURIComponent(orgSlug)}/${encodeURIComponent(siteSlug)}/`;
}

/** Site management for org managers: sites, publishing and rollback. */
export function registerSitesApi(ctx: Context): void {
  async function requireOrg(context: HttpRequestContext) {
    const orgId = param(context, "orgId");
    await assertCan(ctx, context.actor, "manage", { kind: "org", orgId });
    const org = await ctx.content.getOrg(orgId);
    if (!org) {
      throw new DocleusError(
        "api/org-not-found",
        `org "${orgId}" does not exist`,
      );
    }
    return org;
  }

  async function requireSite(context: HttpRequestContext): Promise<Site> {
    const org = await requireOrg(context);
    const siteId = param(context, "siteId");
    const site = await ctx.sites.get(siteId);
    if (site?.orgId !== org.id) {
      throw new DocleusError(
        "sites/not-found",
        `site "${siteId}" does not exist`,
      );
    }
    return site;
  }

  async function present(site: Site) {
    const org = await ctx.content.getOrg(site.orgId);
    return { ...site, url: siteUrl(org?.slug ?? site.orgId, site.slug) };
  }

  ctx.http.route(
    "GET",
    SITES,
    handle(ctx, async (context) => {
      const org = await requireOrg(context);
      const sites = await ctx.sites.list(org.id);
      return json({
        sites: sites.map((site) => ({
          ...site,
          url: siteUrl(org.slug, site.slug),
        })),
      });
    }),
  );

  ctx.http.route(
    "POST",
    SITES,
    handle(ctx, async (context) => {
      const org = await requireOrg(context);
      const input = await readBody(context.request, createSiteBody);
      const site = await ctx.sites.create({ ...input, orgId: org.id });
      return json({ site: await present(site) }, 201);
    }),
  );

  ctx.http.route(
    "PATCH",
    SITE,
    handle(ctx, async (context) => {
      const site = await requireSite(context);
      const input = await readBody(context.request, updateSiteBody);
      return json({
        site: await present(await ctx.sites.update(site.id, input)),
      });
    }),
  );

  ctx.http.route(
    "DELETE",
    SITE,
    handle(ctx, async (context) => {
      const site = await requireSite(context);
      await ctx.sites.remove(site.id);
      return new Response(null, { status: 204 });
    }),
  );

  ctx.http.route(
    "GET",
    `${SITE}/publications`,
    handle(ctx, async (context) => {
      const site = await requireSite(context);
      return json({ publications: await ctx.sites.listPublications(site.id) });
    }),
  );

  ctx.http.route(
    "POST",
    `${SITE}/publications`,
    handle(ctx, async (context) => {
      const site = await requireSite(context);
      const by =
        context.actor.kind === "user" ? context.actor.userId : undefined;
      const publication = await ctx.sites.publish(site.id, { by });
      return json({ publication }, 201);
    }),
  );

  ctx.http.route(
    "POST",
    `${SITE}/activate`,
    handle(ctx, async (context) => {
      const site = await requireSite(context);
      const input = await readBody(context.request, activateBody);
      const by =
        context.actor.kind === "user" ? context.actor.userId : undefined;
      await ctx.sites.activate(site.id, input.publication, { by });
      const updated = await ctx.sites.get(site.id);
      if (!updated) {
        throw new DocleusError(
          "sites/not-found",
          `site "${site.id}" does not exist`,
        );
      }
      return json({ site: await present(updated) });
    }),
  );

  // The site a space's top bar and Site section show: the one whose first
  // space it is (docs/decisions/0013). Readable by the space's readers, so
  // they see the live state; `canPublish` says whether they can change it.
  ctx.http.route(
    "GET",
    "/api/orgs/:orgId/spaces/:spaceId/site",
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "read");
      const org = await ctx.content.getOrg(space.orgId);
      const canPublish = await ctx.authz.can(context.actor, "manage", {
        kind: "org",
        orgId: space.orgId,
      });
      const head = await ctx.content.head(space.id);
      const site = (await ctx.sites.list(space.orgId)).find(
        (candidate) => candidate.spaces[0]?.spaceId === space.id,
      );
      if (!site) {
        return json({ site: null, canPublish, head: head?.id ?? null });
      }
      const publications = await ctx.sites.listPublications(site.id);
      const live = publications.find((each) => each.id === site.active);
      const liveRevision = live?.revisions[space.id];
      const pending = await pendingPages(liveRevision, head);
      const names = new Map<string, string>();
      for (const publication of publications) {
        if (publication.by === undefined || names.has(publication.by)) continue;
        const user = await ctx.identity.getUser(publication.by);
        names.set(publication.by, user?.name ?? user?.email ?? "");
      }
      return json({
        site: {
          ...site,
          url: siteUrl(org?.slug ?? site.orgId, site.slug),
        },
        canPublish,
        head: head?.id ?? null,
        live: live
          ? {
              publication: live.id,
              revision: liveRevision ?? null,
              at: live.at,
            }
          : null,
        pending,
        history: publications
          .toSorted((a, b) => b.at - a.at)
          .slice(0, 20)
          .map((each) => ({
            publication: each.id,
            revision: each.revisions[space.id] ?? null,
            at: each.at,
            by: each.by ?? null,
            byName: each.by === undefined ? null : (names.get(each.by) ?? null),
          })),
      });
    }),
  );

  /** Pages added, changed or removed since `revision`, with their titles. */
  async function pendingPages(
    revision: string | undefined,
    head: Revision | undefined,
  ): Promise<{ id: string; title: string; kind: "A" | "M" | "D" }[]> {
    const before = revision
      ? await ctx.content.getRevision(revision)
      : undefined;
    const was = before?.entries ?? {};
    const now = head?.entries ?? {};
    const titles = async (id: string | undefined) =>
      new Map(
        (id ? await ctx.content.listEntries(id) : []).map((entry) => [
          entry.id,
          entry.title,
        ]),
      );
    const [beforeTitles, headTitles] = await Promise.all([
      titles(before?.id),
      titles(head?.id),
    ]);
    const out: { id: string; title: string; kind: "A" | "M" | "D" }[] = [];
    for (const [id, hash] of Object.entries(now)) {
      if (was[id] === hash) continue;
      const kind = was[id] === undefined ? "A" : "M";
      out.push({ id, title: headTitles.get(id) ?? "", kind });
    }
    for (const id of Object.keys(was)) {
      if (now[id] === undefined) {
        out.push({ id, title: beforeTitles.get(id) ?? "", kind: "D" });
      }
    }
    return out;
  }
}
