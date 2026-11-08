import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobsService } from "@docleus/core-blobs";
import { createBlocksService } from "@docleus/core-blocks";
import { createContentService } from "@docleus/core-content";
import { createInstallationsService } from "@docleus/core-installations";
import { createRenderService } from "@docleus/core-render";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import {
  runConformanceSuite,
  sitesConformanceSuite,
  type SitesSubject,
} from "@docleus/conformance";
import { Context, type Fiber } from "@docleus/kernel";
import {
  ISLAND_SCRIPT_ID,
  PAGE_ENTRY_TYPE,
  parseManifest,
  type BlockNode,
  type EntryContent,
  type ManifestInput,
  type SitePage,
} from "@docleus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SitePluginSource } from "./assets.ts";
import { createSitesService, type SiteCacheOptions } from "./index.ts";

const encoder = new TextEncoder();
const fibers: Fiber[] = [];
const dirs: string[] = [];

const runtimeFiles = (): Map<string, Uint8Array> =>
  new Map([
    ["runtime.js", encoder.encode("export {};")],
    [
      "importmap.json",
      encoder.encode(JSON.stringify({ imports: { react: "vendor/react.js" } })),
    ],
    ["vendor/react.js", encoder.encode("export default {};")],
  ]);

interface Harness extends SitesSubject {
  readonly root: Context;
  readonly sources: SitePluginSource[];
  readonly runtime: Map<string, Uint8Array>;
  /** Every hash read from `blobs`, in order. */
  readonly blobReads: string[];
}

function pluginSource(
  input: Omit<ManifestInput, "engines">,
  files: Record<string, string>,
): SitePluginSource {
  const manifest = parseManifest({ engines: { docleus: "*" }, ...input });
  return {
    manifest,
    manifestBytes: encoder.encode(JSON.stringify(manifest)),
    async readFiles(dir) {
      const prefix = dir === "" ? "" : `${dir}/`;
      return new Map(
        Object.entries(files)
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, content]) => [
            path.slice(prefix.length),
            encoder.encode(content),
          ]),
      );
    },
  };
}

async function freshSites(
  options: { readonly cache?: SiteCacheOptions } = {},
): Promise<Harness> {
  const blobsDir = await mkdtemp(join(tmpdir(), "docleus-sites-"));
  dirs.push(blobsDir);
  const blobReads: string[] = [];
  const root = new Context();
  const sources: SitePluginSource[] = [];
  const runtime = runtimeFiles();
  let subject: SitesSubject | undefined;
  const storageLocation = await testStorageLocation();
  fibers.push(
    await root.plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      const blobs = createBlobsService(blobsDir);
      ctx.provide("blobs", {
        ...blobs,
        get: (hash: string) => {
          blobReads.push(hash);
          return blobs.get(hash);
        },
      });
      ctx.provide("installations", createInstallationsService(ctx));
      ctx.provide("blocks", createBlocksService(ctx));
      ctx.provide("content", createContentService(ctx));
      ctx.provide("render", createRenderService(ctx));
      const sites = createSitesService(ctx, {
        platformVersion: "0.0.1",
        assets: { runtime: async () => runtime, plugins: () => sources },
        ...(options.cache && { cache: options.cache }),
      });
      subject = {
        sites,
        content: ctx.content,
        installations: ctx.installations,
        async loadPlugin(name, apply) {
          fibers.push(await root.plugin({ name, inject: ["render"], apply }));
        },
      };
    }),
  );
  if (!subject) throw new Error("expected the sites subject");
  return { ...subject, root, sources, runtime, blobReads };
}

runConformanceSuite(sitesConformanceSuite, () => freshSites());

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    fibers
      .splice(0)
      .toReversed()
      .map((fiber) => fiber.dispose()),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function page(
  title: string,
  order: number,
  options: {
    parent?: string;
    slug?: string;
    content?: BlockNode[];
  } = {},
): EntryContent {
  return {
    type: PAGE_ENTRY_TYPE,
    title,
    parent: options.parent,
    order,
    fields: options.slug === undefined ? {} : { slug: options.slug },
    body: {
      id: "root",
      type: "doc",
      v: 1,
      attrs: {},
      content: options.content ?? [],
    },
  };
}

async function seed(
  harness: Harness,
  spaces: Record<string, Record<string, EntryContent>>,
  paths: Record<string, string> = {},
) {
  const org = await harness.content.createOrg({ slug: "acme", name: "Acme" });
  const created = [];
  for (const [slug, put] of Object.entries(spaces)) {
    const space = await harness.content.createSpace({
      orgId: org.id,
      slug,
      name: slug,
    });
    await harness.content.commit({
      spaceId: space.id,
      parent: undefined,
      put,
      message: "Initial",
    });
    created.push({ spaceId: space.id, path: paths[slug] ?? "" });
  }
  const site = await harness.sites.create({
    orgId: org.id,
    slug: "docs",
    name: "Docs",
    spaces: created,
  });
  return { org, site, spaces: created };
}

async function filesOf(harness: Harness, siteId: string) {
  const publication = await harness.sites.publish(siteId);
  const artifact = await harness.sites.readArtifact(publication.artifact);
  return { publication, artifact };
}

async function text(harness: Harness, hash: string | undefined) {
  const bytes =
    hash === undefined ? undefined : await harness.root.blobs.get(hash);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}
async function recordingTheme(harness: Harness) {
  const pages: SitePage[] = [];
  await harness.loadPlugin("acme.theme", (ctx) => {
    ctx.render.registerTheme("acme.theme", {
      layout: ({ page: rendered, head, body }) => {
        pages.push(rendered);
        return `<!doctype html><html><head>${head}</head><body>${body.html}</body></html>`;
      },
    });
  });
  return pages;
}

describe("page placement", () => {
  it("places spaces under their paths with slugs, collisions and depth-first prev/next", async () => {
    const harness = await freshSites();
    const pages = await recordingTheme(harness);
    const { site } = await seed(
      harness,
      {
        docs: {
          home: page("Home", 0),
          child: page("Setup", 0, { parent: "home" }),
          setup: page("Setup", 1),
          custom: page("Ignored title", 2, { slug: "custom-slug" }),
          bad: page("Bad", 3, { slug: "../x" }),
        },
        api: {
          intro: page("API", 0),
          ref: page("Reference", 1),
        },
      },
      { docs: "", api: "api" },
    );
    const { artifact } = await filesOf(harness, site.id);
    expect(
      Object.keys(artifact.files).filter((path) => path.endsWith(".html")),
    ).toEqual(
      expect.arrayContaining([
        "/index.html",
        "/setup/index.html",
        "/setup-2/index.html",
        "/custom-slug/index.html",
        "/x/index.html",
        "/api/index.html",
        "/api/reference/index.html",
        "/404.html",
      ]),
    );
    const byPath = new Map(
      pages.filter((p) => p.kind === "page").map((p) => [p.path, p]),
    );
    expect(byPath.get("/")?.next).toEqual({ title: "Setup", path: "/setup/" });
    expect(byPath.get("/setup/")?.prev).toEqual({ title: "Home", path: "/" });
    expect(byPath.get("/setup-2/")?.prev?.path).toBe("/setup/");
    expect(byPath.get("/api/")?.prev).toBeUndefined();
    expect(byPath.get("/api/")?.next?.path).toBe("/api/reference/");
    expect(byPath.get("/")?.nav.map((item) => item.path)).toEqual([
      "/",
      "/setup-2/",
      "/custom-slug/",
      "/x/",
    ]);
    expect(byPath.get("/")?.nav[0]?.children.map((item) => item.path)).toEqual([
      "/setup/",
    ]);
    expect(byPath.get("/setup/")?.url("/api/")).toBe("../api/");
    expect(byPath.get("/")?.url("/")).toBe("./");
    expect(pages.find((p) => p.kind === "not-found")?.path).toBe("/");
  });
});

function chartPlugin() {
  return pluginSource(
    {
      name: "@acme/chart",
      version: "1.2.0",
      entries: { server: "dist/server/index.js", site: "dist/site/index.js" },
      islands: { "acme.chart": "dist/site/chart.js" },
    },
    {
      "dist/site/index.js": "/* site */",
      "dist/site/chart.js": "export function mount() {}",
      "dist/server/index.js": "/* server */",
    },
  );
}

async function withChart(harness: Harness) {
  harness.sources.push(chartPlugin());
  await harness.loadPlugin("@acme/chart", (ctx) => {
    ctx.render.registerBlock("acme.chart", (node) => ({
      html: `<div data-island="acme.chart" data-block="${node.id}"></div>`,
      islands: [{ blockId: node.id, type: "acme.chart", props: { n: 1 } }],
    }));
  });
  const chart: BlockNode = { id: "c1", type: "acme.chart", v: 1, attrs: {} };
  const seeded = await seed(harness, {
    docs: {
      home: page("Home", 0),
      chart: page("Chart", 1, { content: [chart] }),
    },
  });
  await harness.installations.install("@acme/chart");
  await harness.installations.setEnabled(
    "@acme/chart",
    { kind: "org", orgId: seeded.org.id },
    true,
  );
  return seeded;
}

describe("artifact contents", () => {
  it("heads every page with the import map, runtime and enabled site entries", async () => {
    const harness = await freshSites();
    const { site } = await withChart(harness);
    const { artifact } = await filesOf(harness, site.id);
    const home = await text(harness, artifact.files["/index.html"]?.hash);
    expect(home).toContain(
      '<script type="importmap">{"imports":{"react":"./_assets/docleus/vendor/react.js"}}</script><script type="module" src="./_assets/docleus/runtime.js"></script><script type="module" src="./_assets/plugins/acme-chart@1.2.0/index.js"></script>',
    );
    expect(home).not.toContain(ISLAND_SCRIPT_ID);

    const chart = await text(
      harness,
      artifact.files["/chart/index.html"]?.hash,
    );
    expect(chart).toContain("../_assets/docleus/runtime.js");
    expect(chart).toContain(
      `<script type="application/json" id="${ISLAND_SCRIPT_ID}">{"modules":{"acme.chart":"../_assets/plugins/acme-chart@1.2.0/chart.js"},"props":{"c1":{"n":1}}}</script>`,
    );

    const notFound = await text(harness, artifact.files["/404.html"]?.hash);
    expect(notFound).toContain('<base href="./"><script type="importmap">');
    expect(notFound?.indexOf("<base")).toBeLessThan(
      notFound?.indexOf("<script") ?? 0,
    );
  });

  it("copies the runtime and only the browser files of enabled plugins", async () => {
    const harness = await freshSites();
    const { site } = await withChart(harness);
    const { artifact, publication } = await filesOf(harness, site.id);
    expect(Object.keys(artifact.files)).toEqual(
      expect.arrayContaining([
        "/_assets/docleus/runtime.js",
        "/_assets/docleus/importmap.json",
        "/_assets/docleus/vendor/react.js",
        "/_assets/plugins/acme-chart@1.2.0/index.js",
        "/_assets/plugins/acme-chart@1.2.0/chart.js",
      ]),
    );
    expect(
      Object.keys(artifact.files).some((path) => path.includes("server")),
    ).toBe(false);
    expect(
      artifact.files["/_assets/plugins/acme-chart@1.2.0/chart.js"],
    ).toMatchObject({
      type: "text/javascript; charset=utf-8",
      size: "export function mount() {}".length,
    });
    expect(publication.lockfile).toEqual([
      {
        name: "@acme/chart",
        version: "1.2.0",
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        filesSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("leaves disabled plugins out of the head, the files and the lockfile", async () => {
    const harness = await freshSites();
    const { site, org } = await withChart(harness);
    await harness.installations.setEnabled(
      "@acme/chart",
      { kind: "org", orgId: org.id },
      false,
    );
    const { artifact, publication } = await filesOf(harness, site.id);
    expect(publication.lockfile).toEqual([]);
    expect(
      Object.keys(artifact.files).some((path) => path.includes("acme-chart")),
    ).toBe(false);
    const chart = await text(
      harness,
      artifact.files["/chart/index.html"]?.hash,
    );
    expect(chart).not.toContain(ISLAND_SCRIPT_ID);
    expect(chart).toContain('data-unknown-block="acme.chart"');
  });

  it("adds generated site files and skips ones with invalid or taken paths", async () => {
    const harness = await freshSites();
    await harness.loadPlugin("acme.files", (ctx) => {
      ctx.render.registerFile("/sitemap.xml", ({ pages }) => ({
        body: pages.map((p) => p.path).join(","),
        type: "application/xml",
      }));
      ctx.render.registerFile("/../escape.txt", () => ({
        body: "x",
        type: "text/plain",
      }));
      ctx.render.registerFile("/index.html", () => ({
        body: "hijack",
        type: "text/html",
      }));
    });
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    const { artifact } = await filesOf(harness, site.id);
    expect(await text(harness, artifact.files["/sitemap.xml"]?.hash)).toBe("/");
    expect(artifact.files["/escape.txt"]).toBeUndefined();
    expect(await text(harness, artifact.files["/index.html"]?.hash)).not.toBe(
      "hijack",
    );
  });

  it("records the config snapshot with the theme settings and platform version", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const harness = await freshSites();
    await recordingTheme(harness);
    const { site, org } = await seed(harness, {
      docs: { home: page("Home", 0) },
    });
    await harness.installations.install("acme.theme");
    await harness.installations.setEnabled(
      "acme.theme",
      { kind: "org", orgId: org.id },
      true,
    );
    await harness.installations.setSettings(
      "acme.theme",
      { kind: "org", orgId: org.id },
      { accent: "teal" },
    );
    await harness.sites.update(site.id, { theme: "acme.theme" });
    const publication = await harness.sites.publish(site.id, { by: "u1" });
    expect(publication.at).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(publication.config).toEqual({
      name: "Docs",
      theme: "acme.theme",
      themeSettings: { accent: "teal" },
      spaces: site.spaces,
      platformVersion: "0.0.1",
    });
  });

  it("publishes the requested revisions", async () => {
    const harness = await freshSites();
    const { site, spaces } = await seed(harness, {
      docs: { home: page("First", 0) },
    });
    const spaceId = spaces[0]?.spaceId ?? "";
    const first = await harness.content.head(spaceId);
    await harness.content.commit({
      spaceId,
      parent: first?.id,
      put: { home: page("Second", 0) },
      message: "Second",
    });
    const publication = await harness.sites.publish(site.id, {
      revisions: { [spaceId]: first?.id ?? "" },
    });
    expect(publication.revisions).toEqual({ [spaceId]: first?.id });
    const site2 = await harness.sites.get(site.id);
    if (!site2) throw new Error("expected the site");
    const response = await harness.sites.serve(
      site2,
      new Request("http://x.test/"),
      "/",
    );
    expect(await response.text()).toContain("First");
  });

  it("publishes the merge result but rejects its branch snapshot after branch deletion", async () => {
    const harness = await freshSites();
    const { site, spaces } = await seed(harness, {
      docs: { home: page("First", 0) },
    });
    const spaceId = spaces[0]?.spaceId ?? "";
    const first = await harness.content.head(spaceId);
    await harness.content.createBranch({ spaceId, name: "cr/1" });
    const draft = await harness.content.commit({
      spaceId,
      branch: "cr/1",
      parent: first?.id,
      put: { home: page("Merged", 0) },
      message: "Draft",
    });
    const merged = await harness.content.commit({
      spaceId,
      parent: first?.id,
      put: { home: page("Merged", 0) },
      merged: draft.id,
      message: "Merge",
    });
    await harness.content.deleteBranch(spaceId, "cr/1");
    expect(await harness.content.getRevision(draft.id)).toBeDefined();
    await expect(
      harness.sites.publish(site.id, { revisions: { [spaceId]: draft.id } }),
    ).rejects.toMatchObject({ code: "sites/invalid-revision" });
    expect(await harness.sites.listPublications(site.id)).toEqual([]);
    const publication = await harness.sites.publish(site.id, {
      revisions: { [spaceId]: merged.id },
    });
    expect(publication.revisions).toEqual({ [spaceId]: merged.id });
  });
});

describe("error codes", () => {
  it("reports stable codes", async () => {
    const harness = await freshSites();
    const { site, org, spaces } = await seed(harness, {
      docs: { home: page("Home", 0) },
    });
    const { sites } = harness;
    const spaceId = spaces[0]?.spaceId ?? "";
    await sites.update(site.id, { domain: "docs.example.com" });
    const other = await sites.create({
      orgId: org.id,
      slug: "other",
      name: "Other",
      spaces,
    });
    await expect(
      sites.update(other.id, { domain: "DOCS.example.com" }),
    ).rejects.toMatchObject({ code: "sites/domain-taken" });
    await expect(
      sites.update(other.id, { slug: "docs" }),
    ).rejects.toMatchObject({ code: "sites/slug-taken" });
    await expect(
      sites.update(other.id, { domain: "bad host" }),
    ).rejects.toMatchObject({ code: "sites/invalid-domain" });
    await expect(sites.update(other.id, { slug: "Bad" })).rejects.toMatchObject(
      { code: "sites/invalid-slug" },
    );
    await expect(sites.update(other.id, { name: " " })).rejects.toMatchObject({
      code: "sites/invalid-name",
    });
    await expect(
      sites.update(other.id, { spaces: [{ spaceId, path: "A" }] }),
    ).rejects.toMatchObject({ code: "sites/invalid-path" });
    await expect(sites.update(other.id, { spaces: [] })).rejects.toMatchObject({
      code: "sites/invalid-spaces",
    });
    await expect(
      sites.create({ orgId: "nope", slug: "x", name: "X", spaces }),
    ).rejects.toMatchObject({ code: "sites/org-not-found" });
    await expect(sites.update("nope", { name: "X" })).rejects.toMatchObject({
      code: "sites/not-found",
    });
    await expect(sites.publish("nope")).rejects.toMatchObject({
      code: "sites/not-found",
    });
    await expect(
      sites.publish(site.id, { revisions: { [spaceId]: "nope" } }),
    ).rejects.toMatchObject({ code: "sites/invalid-revision" });
    await expect(
      sites.publish(site.id, { revisions: { other: "nope" } }),
    ).rejects.toMatchObject({ code: "sites/invalid-revision" });
    await expect(sites.activate(site.id, "nope")).rejects.toMatchObject({
      code: "sites/publication-not-found",
    });
    const published = await sites.publish(other.id);
    await expect(sites.activate(site.id, published.id)).rejects.toMatchObject({
      code: "sites/publication-not-found",
    });
    await expect(sites.readArtifact("0".repeat(64))).rejects.toMatchObject({
      code: "sites/artifact-not-found",
    });

    const emptySpace = await harness.content.createSpace({
      orgId: org.id,
      slug: "empty",
      name: "Empty",
    });
    const empty = await sites.create({
      orgId: org.id,
      slug: "empty",
      name: "Empty",
      spaces: [{ spaceId: emptySpace.id, path: "" }],
    });
    await expect(sites.publish(empty.id)).rejects.toMatchObject({
      code: "sites/space-empty",
    });
  });

  it("reports a missing site runtime", async () => {
    const harness = await freshSites();
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    harness.runtime.delete("runtime.js");
    await expect(harness.sites.publish(site.id)).rejects.toMatchObject({
      code: "sites/runtime-missing",
    });
  });

  it("keeps serving after a failed publish", async () => {
    const harness = await freshSites();
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    const first = await harness.sites.publish(site.id);
    const script = harness.runtime.get("runtime.js") ?? new Uint8Array();
    harness.runtime.delete("runtime.js");
    await expect(harness.sites.publish(site.id)).rejects.toThrow();
    harness.runtime.set("runtime.js", script);
    expect((await harness.sites.get(site.id))?.active).toBe(first.id);
    const second = await harness.sites.publish(site.id);
    expect((await harness.sites.get(site.id))?.active).toBe(second.id);
  });
});

async function serveHome(harness: Harness, siteId: string) {
  const site = await harness.sites.get(siteId);
  if (!site) throw new Error("expected the site");
  const response = await harness.sites.serve(
    site,
    new Request("http://x.test/sites/acme/docs/"),
    "/",
  );
  expect(response.status).toBe(200);
  return response.text();
}

describe("the serving cache", () => {
  it("serves repeated requests from the disk cache instead of blobs", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "docleus-sites-cache-"));
    dirs.push(cacheDir);
    const harness = await freshSites({
      cache: { dir: cacheDir, maxBytes: 1024 * 1024 },
    });
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    await harness.sites.publish(site.id);

    const first = await serveHome(harness, site.id);
    expect(harness.blobReads.length).toBeGreaterThan(0);
    harness.blobReads.splice(0);
    expect(await serveHome(harness, site.id)).toBe(first);
    expect(harness.blobReads).toEqual([]);
  });

  it("reads blobs on every request without a cache", async () => {
    const harness = await freshSites();
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    await harness.sites.publish(site.id);

    await serveHome(harness, site.id);
    harness.blobReads.splice(0);
    await serveHome(harness, site.id);
    expect(harness.blobReads.length).toBeGreaterThan(0);
  });
});

async function marked(harness: Harness): Promise<Set<string>> {
  const hashes = new Set<string>();
  await harness.root.parallel("blobs/mark", {
    mark: (hash) => void hashes.add(hash),
  });
  return hashes;
}

describe("blob marking", () => {
  it("marks the artifact and every file of each publication", async () => {
    const harness = await freshSites();
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    const first = await harness.sites.publish(site.id);
    const second = await harness.sites.publish(site.id);
    const artifact = await harness.sites.readArtifact(first.artifact);

    const hashes = await marked(harness);
    expect(hashes).toContain(first.artifact);
    expect(hashes).toContain(second.artifact);
    for (const file of Object.values(artifact.files)) {
      expect(hashes).toContain(file.hash);
    }
  });

  it("stops marking the blobs of a removed site", async () => {
    const harness = await freshSites();
    const { site } = await seed(harness, { docs: { home: page("Home", 0) } });
    const publication = await harness.sites.publish(site.id);
    await harness.sites.remove(site.id);

    expect(await marked(harness)).not.toContain(publication.artifact);
  });
});

describe("deleted spaces and orgs", () => {
  it("removes the sites a deleted space starts and drops it from the others", async () => {
    const harness = await freshSites();
    const { org, site, spaces } = await seed(
      harness,
      {
        guides: { home: page("Home", 0) },
        api: { ref: page("Reference", 0) },
      },
      { api: "api" },
    );
    const [guides, api] = spaces;
    if (!guides || !api) throw new Error("expected two spaces");
    const apiSite = await harness.sites.create({
      orgId: org.id,
      slug: "api",
      name: "API",
      spaces: [{ spaceId: api.spaceId, path: "" }],
    });
    await harness.sites.publish(apiSite.id);

    await harness.content.deleteSpace(api.spaceId);
    await harness.content.catchUp("@docleus/core-sites/active");
    expect(await harness.sites.get(apiSite.id)).toBeUndefined();
    expect((await harness.sites.get(site.id))?.spaces).toEqual([guides]);

    await harness.content.deleteSpace(guides.spaceId);
    await harness.content.catchUp("@docleus/core-sites/active");
    expect(await harness.sites.list(org.id)).toEqual([]);
  });

  it("removes every site of a deleted org", async () => {
    const harness = await freshSites();
    const { org } = await seed(harness, { docs: { home: page("Home", 0) } });
    await harness.content.deleteOrg(org.id);
    await harness.content.catchUp("@docleus/core-sites/active");
    expect(await harness.sites.list(org.id)).toEqual([]);
  });
});
