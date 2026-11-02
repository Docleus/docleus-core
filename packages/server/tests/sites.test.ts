import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_ENTRY_TYPE, type BlockNode, type Site } from "@docleus/sdk";
import { testStorageLocation } from "@docleus/testing";
import { afterEach, describe, expect, it } from "vitest";
import { collectBlobs } from "../src/blob-gc.ts";
import { createInstance, type Instance } from "../src/index.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const instances: Instance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function boot(options: { readonly dataDir?: string } = {}) {
  const instance = await createInstance({
    ...options,
    baseDir: fixtures,
    plugins: [{ id: "site", plugin: "site" }],
    database: await testStorageLocation(),
    siteRuntimeDir: `${fixtures}site-runtime`,
    isDev: true,
  });
  instances.push(instance);
  return instance;
}

function get(
  instance: Instance,
  path: string,
  headers: Record<string, string> = {},
) {
  return instance.fetch(new Request(`http://localhost${path}`, { headers }));
}

async function login(instance: Instance, email = "ada@example.com") {
  const response = await instance.fetch(
    new Request("http://localhost/api/auth/dev-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );
  const { token } = (await response.json()) as { token: string };
  return {
    token,
    call(method: string, path: string, body?: unknown) {
      return instance.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
      );
    },
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await this.call(method, path, body);
      if (!res.ok) {
        throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as T;
    },
  };
}

function page(title: string, order: number, content: BlockNode[] = []) {
  return {
    type: PAGE_ENTRY_TYPE,
    title,
    parent: undefined,
    order,
    fields: {},
    body: { id: "root", type: "doc", v: 1, attrs: {}, content },
  };
}

async function setUp(instance: Instance) {
  const admin = await login(instance);
  const { org } = await admin.json<{ org: { id: string } }>(
    "POST",
    "/api/orgs",
    { slug: "acme", name: "Acme" },
  );
  const { space } = await admin.json<{ space: { id: string } }>(
    "POST",
    `/api/orgs/${org.id}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  await admin.json("PUT", `/api/orgs/${org.id}/plugins`, {
    plugin: "@test/site",
    enabled: true,
  });
  await instance.ctx.content.commit({
    spaceId: space.id,
    parent: undefined,
    put: {
      home: page("Home", 0),
      counter: page("Counter", 1, [
        { id: "c1", type: "test.counter", v: 1, attrs: {} },
      ]),
    },
    message: "Initial",
  });
  const sites = `/api/orgs/${org.id}/sites`;
  const created = await admin.call("POST", sites, {
    slug: "docs",
    name: "Docs",
    domain: "Docs.Example.com",
    spaces: [{ spaceId: space.id, path: "" }],
  });
  expect(created.status).toBe(201);
  const { site } = (await created.json()) as { site: Site & { url: string } };
  return { admin, orgId: org.id, spaceId: space.id, site, sites };
}

describe("published sites", () => {
  it("publishes a site and serves it under /sites/ and on its domain", async () => {
    const instance = await boot();
    const { admin, site, sites } = await setUp(instance);
    expect(site.url).toBe("/sites/acme/docs/");
    expect(site.domain).toBe("docs.example.com");
    expect((await get(instance, "/sites/acme/docs/")).status).toBe(404);

    const publish = await admin.call(
      "POST",
      `${sites}/${site.id}/publications`,
    );
    expect(publish.status).toBe(201);
    const { publication } = (await publish.json()) as {
      publication: { id: string; lockfile: { name: string }[] };
    };
    expect(publication.lockfile.map((lock) => lock.name)).toEqual([
      "@test/site",
    ]);

    const redirect = await get(instance, "/sites/acme/docs");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/sites/acme/docs/");

    const home = await get(instance, "/sites/acme/docs/");
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain('data-theme="test-site"');
    expect(homeHtml).toContain(
      '<script type="module" src="./_assets/plugins/test-site@0.0.1/index.js"></script>',
    );
    expect(homeHtml).toContain(
      'href="./_assets/plugins/test-site@0.0.1/style.css"',
    );
    expect(homeHtml).not.toContain("docleus-islands");

    const counter = await (
      await get(instance, "/sites/acme/docs/counter/")
    ).text();
    expect(counter).toContain('id="docleus-islands"');
    expect(counter).toContain(
      '"test.counter":"../_assets/plugins/test-site@0.0.1/counter.js"',
    );

    for (const [path, type] of [
      ["/_assets/docleus/runtime.js", "text/javascript"],
      ["/_assets/docleus/vendor/react.js", "text/javascript"],
      ["/_assets/plugins/test-site@0.0.1/counter.js", "text/javascript"],
      ["/_assets/plugins/test-site@0.0.1/style.css", "text/css"],
    ] as const) {
      const asset = await get(instance, `/sites/acme/docs${path}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain(type);
    }

    const onDomain = await get(instance, "/counter/", {
      host: "DOCS.example.com:8080",
    });
    expect(onDomain.status).toBe(200);
    expect(await onDomain.text()).toBe(counter);
    const missing = await get(instance, "/nope/", { host: "docs.example.com" });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<base href="/">');
    const apiOnDomain = await get(instance, "/api/auth/methods", {
      host: "docs.example.com",
    });
    expect(apiOnDomain.status).toBe(404);

    expect((await get(instance, "/sites/acme/nope/")).status).toBe(404);
  });

  it("caches served blobs under <dataDir>/cache/blobs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "docleus-sites-data-"));
    dirs.push(dataDir);
    const instance = await boot({ dataDir });
    const { admin, site, sites } = await setUp(instance);
    await admin.json("POST", `${sites}/${site.id}/publications`);

    const cacheDir = join(dataDir, "cache", "blobs");
    const cached = async () =>
      (await readdir(cacheDir, { recursive: true }).catch(() => [])).filter(
        (name) => /^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(name),
      );
    expect(await cached()).toEqual([]);
    const first = await (await get(instance, "/sites/acme/docs/")).text();
    expect((await cached()).length).toBeGreaterThan(0);
    expect(await (await get(instance, "/sites/acme/docs/")).text()).toBe(first);
  });

  it("keeps the blobs of publications through blob collection", async () => {
    const instance = await boot();
    const { admin, site, sites } = await setUp(instance);
    const { publication } = await admin.json<{
      publication: { id: string; artifact: string };
    }>("POST", `${sites}/${site.id}/publications`);
    const orphan = await instance.ctx.blobs.put(
      new TextEncoder().encode("orphan"),
    );
    const before = await (await get(instance, "/sites/acme/docs/")).text();

    const later = Date.now() + 3 * 24 * 60 * 60 * 1000;
    const result = await collectBlobs(instance.ctx, { now: () => later });
    expect(result.deleted).toBe(1);
    expect(await instance.ctx.blobs.stat(orphan.hash)).toBeUndefined();
    expect(await instance.ctx.blobs.stat(publication.artifact)).toBeDefined();
    expect(await (await get(instance, "/sites/acme/docs/")).text()).toBe(
      before,
    );
  });

  it("rolls back to an earlier publication", async () => {
    const instance = await boot();
    const { admin, site, sites, spaceId } = await setUp(instance);
    const first = await admin.json<{ publication: { id: string } }>(
      "POST",
      `${sites}/${site.id}/publications`,
    );
    const head = await instance.ctx.content.head(spaceId);
    await instance.ctx.content.commit({
      spaceId,
      parent: head?.id,
      put: { home: page("Home v2", 0) },
      message: "Second",
    });
    const second = await admin.json<{ publication: { id: string } }>(
      "POST",
      `${sites}/${site.id}/publications`,
    );
    expect(await (await get(instance, "/sites/acme/docs/")).text()).toContain(
      "Home v2",
    );

    const { publications } = await admin.json<{
      publications: { id: string }[];
    }>("GET", `${sites}/${site.id}/publications`);
    expect(publications.map((p) => p.id)).toEqual([
      second.publication.id,
      first.publication.id,
    ]);

    const { site: rolledBack } = await admin.json<{ site: Site }>(
      "POST",
      `${sites}/${site.id}/activate`,
      { publication: first.publication.id },
    );
    expect(rolledBack.active).toBe(first.publication.id);
    expect(
      await (await get(instance, "/sites/acme/docs/")).text(),
    ).not.toContain("Home v2");
  });

  it("manages sites with stable error codes", async () => {
    const instance = await boot();
    const { admin, site, sites, spaceId } = await setUp(instance);
    const { sites: listed } = await admin.json<{ sites: Site[] }>("GET", sites);
    expect(listed.map((s) => s.id)).toEqual([site.id]);

    const taken = await admin.call("POST", sites, {
      slug: "docs",
      name: "Again",
      spaces: [{ spaceId, path: "" }],
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "sites/slug-taken" });

    const cases: [unknown, number, string][] = [
      [{ domain: "bad host" }, 400, "sites/invalid-domain"],
      [{ spaces: [{ spaceId, path: "A" }] }, 400, "sites/invalid-path"],
      [{ slug: "Bad Slug" }, 400, "sites/invalid-slug"],
      [{ name: 3 }, 400, "api/invalid-request"],
    ];
    for (const [body, status, code] of cases) {
      const response = await admin.call("PATCH", `${sites}/${site.id}`, body);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }

    const renamed = await admin.json<{ site: Site & { url: string } }>(
      "PATCH",
      `${sites}/${site.id}`,
      { slug: "handbook", domain: null },
    );
    expect(renamed.site).toMatchObject({
      slug: "handbook",
      url: "/sites/acme/handbook/",
    });
    expect(renamed.site.domain).toBeUndefined();

    const unknown = await admin.call("POST", `${sites}/${site.id}/activate`, {
      publication: "nope",
    });
    expect(unknown.status).toBe(404);

    expect((await admin.call("DELETE", `${sites}/${site.id}`)).status).toBe(
      204,
    );
    const gone = await admin.call("GET", `${sites}/${site.id}/publications`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: "sites/not-found" });
  });

  it("allows only org managers to manage sites", async () => {
    const instance = await boot();
    const { site, sites, orgId } = await setUp(instance);
    const eve = await login(instance, "eve@example.com");
    const user = await instance.ctx.identity.authenticate(eve.token);
    if (!user) throw new Error("expected a user");
    await instance.ctx.authz.revoke(user.id, { kind: "instance" });

    expect((await eve.call("GET", sites)).status).toBe(403);
    expect(
      (await eve.call("POST", `${sites}/${site.id}/publications`)).status,
    ).toBe(403);
    await instance.ctx.authz.grant(user.id, { kind: "org", orgId }, "member");
    expect((await eve.call("GET", sites)).status).toBe(403);
    await instance.ctx.authz.grant(user.id, { kind: "org", orgId }, "admin");
    expect((await eve.call("GET", sites)).status).toBe(200);
  });
});

describe("the site of a space", () => {
  it("reports the live revision and the pages main has changed since", async () => {
    const instance = await boot();
    const { admin, orgId, spaceId, site, sites } = await setUp(instance);
    const status = `/api/orgs/${orgId}/spaces/${spaceId}/site`;
    type Status = {
      site: { id: string; url: string } | null;
      canPublish: boolean;
      head: string | null;
      live: { revision: string | null } | null;
      pending: { id: string; title: string; kind: string }[];
      history: { revision: string | null; byName: string | null }[];
    };

    const before = await admin.json<Status>("GET", status);
    expect(before.site?.id).toBe(site.id);
    expect(before.live).toBeNull();
    expect(before.pending.map((each) => each.kind).toSorted()).toEqual([
      "A",
      "A",
    ]);

    await admin.json("POST", `${sites}/${site.id}/publications`);
    const published = await admin.json<Status>("GET", status);
    expect(published.live?.revision).toBe(published.head);
    expect(published.pending).toEqual([]);
    expect(published.history).toHaveLength(1);
    expect(published.canPublish).toBe(true);

    const head = await instance.ctx.content.head(spaceId);
    await instance.ctx.content.commit({
      spaceId,
      parent: head?.id,
      put: { home: page("Home, revised", 0) },
      remove: ["counter"],
      message: "Edit",
    });
    const ahead = await admin.json<Status>("GET", status);
    expect(ahead.pending).toEqual([
      { id: "home", title: "Home, revised", kind: "M" },
      { id: "counter", title: "Counter", kind: "D" },
    ]);
  });

  it("is empty for a space no site starts from", async () => {
    const instance = await boot();
    const { admin, orgId } = await setUp(instance);
    const { space } = await admin.json<{ space: { id: string } }>(
      "POST",
      `/api/orgs/${orgId}/spaces`,
      { slug: "other", name: "Other" },
    );
    expect(
      await admin.json("GET", `/api/orgs/${orgId}/spaces/${space.id}/site`),
    ).toEqual({ site: null, canPublish: true, head: null });
  });
});
