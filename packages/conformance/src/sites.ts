import {
  PAGE_ENTRY_TYPE,
  SITE_PUBLISHED,
  type BlockNode,
  type ContentService,
  type Context,
  type EntryContent,
  type InstallationsService,
  type Revision,
  type Site,
  type SitesService,
  type Space,
} from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

/**
 * A sites service with the services it publishes from. The subject's asset
 * source must provide a site runtime; it need not provide any plugins.
 */
export interface SitesSubject {
  readonly sites: SitesService;
  readonly content: ContentService;
  readonly installations: InstallationsService;
  /**
   * Loads a plugin named `name` on the subject's root context, so its
   * renderers and hooks are owned by `name`. It is not installed.
   */
  loadPlugin(name: string, apply: (ctx: Context) => void): Promise<void>;
}

interface Fixture {
  readonly orgId: string;
  readonly space: Space;
  readonly site: Site;
  readonly head: Revision;
}

function page(
  title: string,
  order: number,
  parent?: string,
  content: BlockNode[] = [],
): EntryContent {
  return {
    type: PAGE_ENTRY_TYPE,
    title,
    parent,
    order,
    fields: {},
    body: { id: "root", type: "doc", v: 1, attrs: {}, content },
  };
}

async function setUp(
  { content, sites }: SitesSubject,
  options: { readonly domain?: string; readonly body?: BlockNode[] } = {},
): Promise<Fixture> {
  const org = await content.createOrg({ slug: "acme", name: "Acme" });
  const space = await content.createSpace({
    orgId: org.id,
    slug: "docs",
    name: "Docs",
  });
  const head = await content.commit({
    spaceId: space.id,
    parent: undefined,
    put: {
      intro: page("Intro", 0, undefined, options.body),
      guide: page("Guide", 1),
      install: page("Install", 0, "guide"),
    },
    message: "Initial",
  });
  const site = await sites.create({
    orgId: org.id,
    slug: "docs",
    name: "Docs",
    spaces: [{ spaceId: space.id, path: "" }],
    ...(options.domain !== undefined && { domain: options.domain }),
  });
  return { orgId: org.id, space, site, head };
}

async function retitle(
  content: ContentService,
  fixture: Pick<Fixture, "space">,
  title: string,
): Promise<void> {
  const head = await content.head(fixture.space.id);
  await content.commit({
    spaceId: fixture.space.id,
    parent: head?.id,
    put: { intro: page(title, 0) },
    message: `Retitle ${title}`,
  });
}

async function fresh(sites: SitesService, id: string): Promise<Site> {
  const site = await sites.get(id);
  if (!site) throw new Error(`expected site ${id}`);
  return site;
}

async function request(
  sites: SitesService,
  siteId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const site = await fresh(sites, siteId);
  return sites.serve(
    site,
    new Request(`http://sites.test/sites/acme/docs${path}`, init),
    path.split("?")[0] ?? path,
  );
}

async function body(
  sites: SitesService,
  siteId: string,
  path: string,
): Promise<string> {
  const response = await request(sites, siteId, path);
  expect(response.status).toBe(200);
  return response.text();
}

export const sitesConformanceSuite = defineConformanceSuite<SitesSubject>(
  "sites",
  [
    {
      name: "a created site can be read back, listed, and found by slug",
      async check(subject) {
        const { site, orgId } = await setUp(subject);
        const { sites } = subject;
        expect(site.active).toBeUndefined();
        expect(await sites.get(site.id)).toEqual(site);
        expect(await sites.list(orgId)).toEqual([site]);
        expect(await sites.findBySlug("acme", "docs")).toEqual(site);
        expect(await sites.findBySlug("acme", "nope")).toBeUndefined();
        expect(await sites.get("no-such-site")).toBeUndefined();
      },
    },
    {
      name: "site slugs are unique within an org but may repeat across orgs",
      async check(subject) {
        const { space, orgId } = await setUp(subject);
        const { content, sites } = subject;
        await expectToReject(() =>
          sites.create({
            orgId,
            slug: "docs",
            name: "Again",
            spaces: [{ spaceId: space.id, path: "" }],
          }),
        );
        await expectToReject(() =>
          sites.create({
            orgId,
            slug: "Not A Slug",
            name: "X",
            spaces: [{ spaceId: space.id, path: "" }],
          }),
        );
        const other = await content.createOrg({ slug: "other", name: "O" });
        const otherSpace = await content.createSpace({
          orgId: other.id,
          slug: "docs",
          name: "Docs",
        });
        await sites.create({
          orgId: other.id,
          slug: "docs",
          name: "Docs",
          spaces: [{ spaceId: otherSpace.id, path: "" }],
        });
      },
    },
    {
      name: "domains are normalized to a lowercase host name without a port",
      async check(subject) {
        const { site } = await setUp(subject, {
          domain: "Docs.Example.COM:8080",
        });
        const { sites } = subject;
        expect(site.domain).toBe("docs.example.com");
        expect((await sites.findByDomain("DOCS.example.com:443"))?.id).toBe(
          site.id,
        );
        expect(await sites.findByDomain("other.example.com")).toBeUndefined();
        await expectToReject(() =>
          sites.update(site.id, { domain: "not a host" }),
        );
        await expectToReject(() =>
          sites.update(site.id, { domain: "a/b.example.com" }),
        );
        const cleared = await sites.update(site.id, { domain: null });
        expect(cleared.domain).toBeUndefined();
      },
    },
    {
      name: "a domain is unique across the instance, ignoring case and port",
      async check(subject) {
        await setUp(subject, { domain: "docs.example.com" });
        const { content, sites } = subject;
        const other = await content.createOrg({ slug: "other", name: "O" });
        const space = await content.createSpace({
          orgId: other.id,
          slug: "docs",
          name: "Docs",
        });
        await expectToReject(() =>
          sites.create({
            orgId: other.id,
            slug: "docs",
            name: "Docs",
            domain: "DOCS.example.com:80",
            spaces: [{ spaceId: space.id, path: "" }],
          }),
        );
      },
    },
    {
      name: "invalid space lists are rejected",
      async check(subject) {
        const { space, orgId, site } = await setUp(subject);
        const { content, sites } = subject;
        const second = await content.createSpace({
          orgId,
          slug: "api",
          name: "API",
        });
        const other = await content.createOrg({ slug: "other", name: "O" });
        const foreign = await content.createSpace({
          orgId: other.id,
          slug: "docs",
          name: "Docs",
        });
        const invalid = [
          [],
          [
            { spaceId: space.id, path: "" },
            { spaceId: space.id, path: "api" },
          ],
          [
            { spaceId: space.id, path: "api" },
            { spaceId: second.id, path: "api" },
          ],
          [{ spaceId: space.id, path: "API" }],
          [{ spaceId: space.id, path: "/api" }],
          [{ spaceId: space.id, path: "a/../b" }],
          [{ spaceId: "no-such-space", path: "" }],
          [{ spaceId: foreign.id, path: "" }],
        ];
        for (const spaces of invalid) {
          await expectToReject(() =>
            sites.create({ orgId, slug: "s2", name: "S", spaces }),
          );
          await expectToReject(() => sites.update(site.id, { spaces }));
        }
        const updated = await sites.update(site.id, {
          spaces: [
            { spaceId: space.id, path: "" },
            { spaceId: second.id, path: "api/v1" },
          ],
        });
        expect(updated.spaces).toHaveLength(2);
      },
    },
    {
      name: "a site needs a non-empty name",
      async check(subject) {
        const { site } = await setUp(subject);
        await expectToReject(() => subject.sites.update(site.id, { name: "" }));
      },
    },
    {
      name: "publish creates the active publication and appends site/published",
      async check(subject) {
        const { site, head, space } = await setUp(subject);
        const { sites, content } = subject;
        const publication = await sites.publish(site.id, { by: "user-1" });
        expect(publication.siteId).toBe(site.id);
        expect(publication.revisions).toEqual({ [space.id]: head.id });
        expect(publication.by).toBe("user-1");
        expect(publication.config.name).toBe("Docs");
        expect(publication.config.spaces).toEqual(site.spaces);
        expect((await sites.get(site.id))?.active).toBe(publication.id);
        expect(await sites.getPublication(publication.id)).toEqual(publication);
        const log = await content.readLog();
        expect(log.at(-1)).toMatchObject({
          type: SITE_PUBLISHED,
          payload: {
            siteId: site.id,
            publication: publication.id,
            artifact: publication.artifact,
            rollback: false,
          },
        });
      },
    },
    {
      name: "publishing a space without a revision is rejected",
      async check(subject) {
        const { content, sites } = subject;
        const org = await content.createOrg({ slug: "acme", name: "Acme" });
        const space = await content.createSpace({
          orgId: org.id,
          slug: "empty",
          name: "Empty",
        });
        const site = await sites.create({
          orgId: org.id,
          slug: "docs",
          name: "Docs",
          spaces: [{ spaceId: space.id, path: "" }],
        });
        await expectToReject(() => sites.publish(site.id));
        expect(await sites.listPublications(site.id)).toEqual([]);
      },
    },
    {
      name: "publishing rejects branch revisions and preserves the active main publication",
      async check(subject) {
        const { site, space, head } = await setUp(subject);
        const { content, sites } = subject;
        const live = await sites.publish(site.id);
        await content.createBranch({ spaceId: space.id, name: "cr/1" });
        const draft = await content.commit({
          spaceId: space.id,
          branch: "cr/1",
          parent: head.id,
          put: { intro: page("Unreviewed draft", 0) },
          message: "Draft",
        });
        await expect(
          sites.publish(site.id, { revisions: { [space.id]: draft.id } }),
        ).rejects.toMatchObject({ code: "sites/invalid-revision" });
        expect((await sites.get(site.id))?.active).toBe(live.id);
        expect(await sites.listPublications(site.id)).toHaveLength(1);
        const published = await sites.publish(site.id);
        expect(published.revisions).toEqual({ [space.id]: head.id });
        expect(published.artifact).toBe(live.artifact);
      },
    },
    {
      name: "the artifact maps every page to its file, and identical inputs give an identical artifact",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        const first = await sites.publish(site.id);
        const second = await sites.publish(site.id);
        expect(second.id).not.toBe(first.id);
        expect(second.artifact).toBe(first.artifact);
        const artifact = await sites.readArtifact(first.artifact);
        expect(artifact.format).toBe(1);
        expect(Object.keys(artifact.files)).toEqual(
          expect.arrayContaining([
            "/index.html",
            "/guide/index.html",
            "/guide/install/index.html",
            "/404.html",
          ]),
        );
        expect(artifact.files["/index.html"]?.type).toMatch(/^text\/html/);
      },
    },
    {
      name: "an artifact never changes once written",
      async check(subject) {
        const { site, space } = await setUp(subject);
        const { sites, content } = subject;
        const first = await sites.publish(site.id);
        const before = await sites.readArtifact(first.artifact);
        await retitle(content, { space }, "Changed");
        const second = await sites.publish(site.id);
        expect(second.artifact).not.toBe(first.artifact);
        expect(await sites.readArtifact(first.artifact)).toEqual(before);
        expect((await sites.getPublication(first.id))?.artifact).toBe(
          first.artifact,
        );
      },
    },
    {
      name: "activate rolls back to an earlier publication without rebuilding",
      async check(subject) {
        const { site, space } = await setUp(subject);
        const { sites, content } = subject;
        await retitle(content, { space }, "Version one");
        const first = await sites.publish(site.id);
        await retitle(content, { space }, "Version two");
        const second = await sites.publish(site.id);
        expect(await body(sites, site.id, "/")).toContain("Version two");

        await sites.activate(site.id, first.id, { by: "user-2" });
        expect((await sites.get(site.id))?.active).toBe(first.id);
        expect(await body(sites, site.id, "/")).toContain("Version one");
        expect(
          (await sites.listPublications(site.id)).map((p) => p.id),
        ).toEqual([second.id, first.id]);
        expect((await content.readLog()).at(-1)).toMatchObject({
          type: SITE_PUBLISHED,
          payload: { publication: first.id, rollback: true },
        });
        await expectToReject(() => sites.activate(site.id, "no-such-id"));
      },
    },
    {
      name: "listPublications is newest first",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push((await sites.publish(site.id)).id);
        expect(
          (await sites.listPublications(site.id)).map(
            (publication) => publication.id,
          ),
        ).toEqual(ids.toReversed());
      },
    },
    {
      name: "removing a site removes its publications and ignores its log entries",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        const publication = await sites.publish(site.id);
        await sites.remove(site.id);
        expect(await sites.get(site.id)).toBeUndefined();
        expect(await sites.getPublication(publication.id)).toBeUndefined();
        expect(await sites.listPublications(site.id)).toEqual([]);
        expect(await sites.findBySlug("acme", "docs")).toBeUndefined();
      },
    },
    {
      name: "serve answers 404 while a site has no active publication",
      async check(subject) {
        const { site } = await setUp(subject);
        const response = await request(subject.sites, site.id, "/");
        expect(response.status).toBe(404);
      },
    },
    {
      name: "serve maps directory paths to index.html and redirects paths without a trailing slash",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        await sites.publish(site.id);
        const root = await request(sites, site.id, "/");
        expect(root.status).toBe(200);
        expect(root.headers.get("content-type")).toMatch(/^text\/html/);
        expect(await root.text()).toContain("Intro");
        expect(await body(sites, site.id, "/guide/install/")).toContain(
          "Install",
        );
        expect(await body(sites, site.id, "/guide/index.html")).toContain(
          "Guide",
        );
        const redirect = await request(sites, site.id, "/guide?x=1");
        expect(redirect.status).toBe(308);
        expect(redirect.headers.get("location")).toBe(
          "/sites/acme/docs/guide/?x=1",
        );
      },
    },
    {
      name: "unknown paths get the 404 page with status 404 and a base pointing at the site root",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        await sites.publish(site.id);
        const response = await request(sites, site.id, "/no/such/page/");
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toMatch(/^text\/html/);
        expect(await response.text()).toContain(
          '<base href="/sites/acme/docs/">',
        );
        expect((await request(sites, site.id, "/missing.txt")).status).toBe(
          404,
        );
      },
    },
    {
      name: "paths that would leave the site or are badly encoded are not served",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        await sites.publish(site.id);
        for (const path of [
          "/../index.html",
          "/guide/../index.html",
          "/%2e%2e/index.html",
          "/guide%2findex.html",
          "/guide%5cindex.html",
          "/%E0%A4%A",
          "/guide/%00",
        ]) {
          expect((await request(sites, site.id, path)).status).toBe(404);
        }
      },
    },
    {
      name: "files carry their type, an etag and nosniff, and a matching If-None-Match gives 304",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        await sites.publish(site.id);
        const runtime = await request(
          sites,
          site.id,
          "/_assets/docleus/runtime.js",
        );
        expect(runtime.status).toBe(200);
        expect(runtime.headers.get("content-type")).toMatch(
          /^text\/javascript/,
        );
        expect(runtime.headers.get("x-content-type-options")).toBe("nosniff");
        const etag = runtime.headers.get("etag");
        expect(etag).toMatch(/^"[^"]+"$/);
        const cached = await request(
          sites,
          site.id,
          "/_assets/docleus/runtime.js",
          { headers: { "if-none-match": etag ?? "" } },
        );
        expect(cached.status).toBe(304);
        expect(cached.headers.get("etag")).toBe(etag);
        expect(await cached.text()).toBe("");
        const changed = await request(
          sites,
          site.id,
          "/_assets/docleus/runtime.js",
          { headers: { "if-none-match": '"other"' } },
        );
        expect(changed.status).toBe(200);
      },
    },
    {
      name: "HEAD answers without a body and other methods get 405",
      async check(subject) {
        const { site } = await setUp(subject);
        const { sites } = subject;
        await sites.publish(site.id);
        const head = await request(sites, site.id, "/", { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("etag")).not.toBeNull();
        expect(await head.text()).toBe("");
        const post = await request(sites, site.id, "/", { method: "POST" });
        expect(post.status).toBe(405);
        expect(post.headers.get("allow")).toContain("GET");
      },
    },
    {
      name: "renderers of plugins disabled in a space render as placeholders",
      async check(subject) {
        const { installations, sites } = subject;
        await subject.loadPlugin("acme.box", (ctx) => {
          ctx.render.registerBlock("acme.box", () => ({
            html: "<p>BOX RENDERED</p>",
            islands: [],
          }));
        });
        const { site, space, orgId } = await setUp(subject, {
          body: [{ id: "b1", type: "acme.box", v: 1, attrs: {} }],
        });
        await installations.install("acme.box");
        await installations.setEnabled(
          "acme.box",
          { kind: "org", orgId },
          true,
        );
        await sites.publish(site.id);
        expect(await body(sites, site.id, "/")).toContain("BOX RENDERED");

        await installations.setEnabled(
          "acme.box",
          { kind: "space", orgId, spaceId: space.id },
          false,
        );
        await sites.publish(site.id);
        expect(await body(sites, site.id, "/")).not.toContain("BOX RENDERED");
      },
    },
    {
      name: "site/request hooks wrap the response of enabled plugins only",
      async check(subject) {
        const { installations, sites } = subject;
        await subject.loadPlugin("acme.headers", (ctx) => {
          ctx.on("site/request", async (input, next) => {
            const response = await next();
            const headers = new Headers(response.headers);
            headers.set("x-acme-path", input.path);
            return new Response(response.body, {
              status: response.status,
              headers,
            });
          });
        });
        const { site, orgId } = await setUp(subject);
        await sites.publish(site.id);
        await installations.install("acme.headers");
        expect(
          (await request(sites, site.id, "/guide/")).headers.get("x-acme-path"),
        ).toBeNull();
        await installations.setEnabled(
          "acme.headers",
          { kind: "org", orgId },
          true,
        );
        const response = await request(sites, site.id, "/guide/");
        expect(response.status).toBe(200);
        expect(response.headers.get("x-acme-path")).toBe("/guide/");
      },
    },
    {
      name: "publishes and activations of one site run one at a time",
      async check(subject) {
        const events: string[] = [];
        await subject.loadPlugin("acme.files", (ctx) => {
          ctx.render.registerFile("/build.txt", () => {
            events.push("build");
            return { body: "x", type: "text/plain; charset=utf-8" };
          });
        });
        const { site } = await setUp(subject);
        const { sites } = subject;
        const runs = [1, 2, 3].map((n) =>
          sites.publish(site.id).then((publication) => {
            events.push(`done ${n}`);
            return publication;
          }),
        );
        const publications = await Promise.all(runs);
        expect(events).toEqual([
          "build",
          "done 1",
          "build",
          "done 2",
          "build",
          "done 3",
        ]);
        expect((await sites.get(site.id))?.active).toBe(publications[2]?.id);
      },
    },
  ],
);
