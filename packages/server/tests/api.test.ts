import { fileURLToPath } from "node:url";
import { toEditorDocument, type BlockNode } from "@docleus/sdk";
import { testStorageLocation } from "@docleus/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createInstance, type Instance } from "../src/index.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const instances: Instance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

async function boot(options: { isDev?: boolean } = {}) {
  const instance = await createInstance({
    baseDir: fixtures,
    plugins: [{ id: "browser", plugin: "browser" }],
    database: await testStorageLocation(),
    appDir: `${fixtures}app`,
    isDev: options.isDev ?? true,
  });
  instances.push(instance);
  return instance;
}

interface Client {
  call(method: string, path: string, body?: unknown): Promise<Response>;
  json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T>;
}

function client(instance: Instance, token?: string): Client {
  const call = (method: string, path: string, body?: unknown) =>
    instance.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(token && { authorization: `Bearer ${token}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );
  return {
    call,
    async json(method, path, body) {
      const response = await call(method, path, body);
      if (!response.ok) {
        throw new Error(
          `${method} ${path}: ${response.status} ${await response.text()}`,
        );
      }
      return (await response.json()) as never;
    },
  };
}

async function login(instance: Instance, email = "ada@example.com") {
  const { token } = await client(instance).json<{ token: string }>(
    "POST",
    "/api/auth/dev-login",
    { email },
  );
  return client(instance, token);
}

async function setUpSpace(api: Client) {
  const { org } = await api.json<{ org: { id: string } }>("POST", "/api/orgs", {
    slug: "acme",
    name: "Acme",
  });
  const { space } = await api.json<{ space: { id: string } }>(
    "POST",
    `/api/orgs/${org.id}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  return `/api/orgs/${org.id}/spaces/${space.id}`;
}

interface PageResponse {
  page: { id: string; title: string; parent?: string; body: BlockNode };
  head: string;
}

describe("instance API", () => {
  it("logs in with the development provider as an instance admin", async () => {
    const instance = await boot();
    expect(await client(instance).json("GET", "/api/auth/methods")).toEqual({
      password: true,
      dev: true,
      providers: [],
      setupRequired: false,
    });
    const api = await login(instance);
    const me = await api.json("GET", "/api/me");
    expect(me).toMatchObject({
      user: { email: "ada@example.com" },
      isAdmin: true,
    });
  });

  it("starts a cookie session with the development login", async () => {
    const instance = await boot();
    const response = await client(instance).call(
      "POST",
      "/api/auth/dev-login",
      { email: "ada@example.com" },
    );
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("expected a session cookie");
    const me = await instance.fetch(
      new Request("http://localhost/api/me", { headers: { cookie } }),
    );
    expect(await me.json()).toMatchObject({
      user: { email: "ada@example.com" },
    });
  });

  it("has no development login without --dev", async () => {
    const instance = await boot({ isDev: false });
    expect(await client(instance).json("GET", "/api/auth/methods")).toEqual({
      password: true,
      dev: false,
      providers: [],
      setupRequired: true,
    });
    const response = await client(instance).call(
      "POST",
      "/api/auth/dev-login",
      { email: "ada@example.com" },
    );
    expect(response.status).toBe(404);
  });

  it("creates, renames, moves and deletes pages", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);

    const a = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "A",
    });
    const b = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "B",
    });
    const child = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "Child",
      parent: a.page.id,
    });

    await api.json("PATCH", `${space}/pages/${b.page.id}`, { title: "B2" });
    await api.json("PATCH", `${space}/pages/${child.page.id}`, {
      parent: b.page.id,
    });
    let tree = await api.json<{
      pages: { id: string; title: string; parent: string | null }[];
    }>("GET", space);
    expect(
      tree.pages.map(({ title, parent }) => [title, parent]).toSorted(),
    ).toEqual([
      ["A", null],
      ["B2", null],
      ["Child", b.page.id],
    ]);

    const cycle = await api.call("PATCH", `${space}/pages/${b.page.id}`, {
      parent: child.page.id,
    });
    expect(cycle.status).toBe(400);

    await api.json("DELETE", `${space}/pages/${b.page.id}`);
    tree = await api.json("GET", space);
    expect(tree.pages.map((page) => page.title)).toEqual(["A"]);
  });

  it("saves editor JSON as a new revision and loads it back", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);
    const created = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "Hello",
    });
    const body: BlockNode = {
      ...created.page.body,
      content: [
        {
          id: "p1",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [{ type: "text", text: "hi", marks: [{ type: "bold" }] }],
        },
        {
          id: "x1",
          type: "acme.widget",
          v: 3,
          attrs: { size: 2 },
          content: [{ id: "x2", type: "paragraph", v: 1, attrs: {} }],
        },
      ],
    };
    const saved = await api.json<{ head: string }>(
      "PUT",
      `${space}/pages/${created.page.id}/body`,
      { base: created.head, document: toEditorDocument(body) },
    );
    const loaded = await api.json<PageResponse>(
      "GET",
      `${space}/pages/${created.page.id}`,
    );
    expect(loaded.head).toBe(saved.head);
    expect(loaded.page.body).toEqual(body);
  });

  it("keeps the stored form of blocks the editor only respelled", async () => {
    const instance = await boot();
    const api = await login(instance);
    const space = await setUpSpace(api);
    const created = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "Hello",
    });
    const spaceId = space.split("/")[5] ?? "";
    const stored: BlockNode = {
      ...created.page.body,
      content: [
        {
          id: "p1",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [
            { type: "text", text: "a" },
            {
              type: "text",
              text: "b",
              marks: [{ type: "italic" }, { type: "bold" }],
            },
          ],
        },
        {
          id: "p2",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [{ type: "text", text: "old" }],
        },
      ],
    };
    const head = await instance.ctx.content.head(spaceId);
    const revision = await instance.ctx.content.commit({
      spaceId,
      parent: head?.id,
      put: {
        [created.page.id]: {
          type: "page",
          title: "Hello",
          parent: undefined,
          order: 0,
          fields: {},
          body: stored,
        },
      },
      message: "import",
    });
    const respelled: BlockNode = {
      ...stored,
      content: [
        {
          id: "p1",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [
            { type: "text", text: "a" },
            {
              type: "text",
              text: "b",
              marks: [{ type: "bold" }, { type: "italic" }],
            },
          ],
        },
        {
          id: "p2",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [{ type: "text", text: "new" }],
        },
      ],
    };
    await api.json("PUT", `${space}/pages/${created.page.id}/body`, {
      base: revision.id,
      document: toEditorDocument(respelled),
    });
    const loaded = await api.json<PageResponse>(
      "GET",
      `${space}/pages/${created.page.id}`,
    );
    expect(loaded.page.body.content?.[0]).toEqual(stored.content?.[0]);
    expect(loaded.page.body.content?.[1]).toEqual(respelled.content?.[1]);
  });

  it("rejects a save when the page changed since its base revision", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);
    const page = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "A",
    });
    const other = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "B",
    });
    const document = toEditorDocument({
      ...page.page.body,
      content: [
        {
          id: "p1",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [{ type: "text", text: "edited" }],
        },
      ],
    });
    const path = `${space}/pages/${page.page.id}/body`;

    // Another page changed since: the save goes through.
    await api.json("PUT", path, { base: page.head, document });
    expect(other.head).not.toBe(page.head);

    // This page changed since: the save is rejected.
    const stale = await api.call("PUT", path, { base: page.head, document });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "api/stale-head" });
  });

  it("accepts a save based on a revision from before the page was renamed or moved", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);
    const page = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "A",
    });
    const document = toEditorDocument({
      ...page.page.body,
      content: [
        {
          id: "p1",
          type: "paragraph",
          v: 1,
          attrs: {},
          inline: [{ type: "text", text: "edited" }],
        },
      ],
    });
    await api.json("PATCH", `${space}/pages/${page.page.id}`, {
      title: "Renamed",
    });
    await api.json("PATCH", `${space}/pages/${page.page.id}`, { order: 5 });

    await api.json("PUT", `${space}/pages/${page.page.id}/body`, {
      base: page.head,
      document,
    });
    const loaded = await api.json<PageResponse>(
      "GET",
      `${space}/pages/${page.page.id}`,
    );
    expect(loaded.page).toMatchObject({ title: "Renamed", order: 5 });
    expect(loaded.page.body.content?.[0]?.inline).toEqual([
      { type: "text", text: "edited" },
    ]);
  });

  it("rejects invalid editor JSON with 400", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);
    const page = await api.json<PageResponse>("POST", `${space}/pages`, {
      title: "A",
    });
    const response = await api.call(
      "PUT",
      `${space}/pages/${page.page.id}/body`,
      {
        base: page.head,
        document: { type: "paragraph" },
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "editor/invalid-document",
    });
  });

  it("checks roles on every space route", async () => {
    const instance = await boot();
    const admin = await login(instance);
    const space = await setUpSpace(admin);
    const page = await admin.json<PageResponse>("POST", `${space}/pages`, {
      title: "A",
    });

    expect((await client(instance).call("GET", space)).status).toBe(401);

    const { token } = await client(instance).json<{ token: string }>(
      "POST",
      "/api/auth/dev-login",
      { email: "eve@example.com" },
    );
    const eve = await instance.ctx.identity.authenticate(token);
    if (!eve) throw new Error("expected a user");
    await instance.ctx.authz.revoke(eve.id, { kind: "instance" });
    const outsider = client(instance, token);
    expect((await outsider.call("GET", space)).status).toBe(403);
    expect((await outsider.call("GET", "/api/orgs")).status).toBe(200);
    expect(await outsider.json("GET", "/api/orgs")).toEqual({ orgs: [] });

    const [, , , orgId, , spaceId] = space.split("/");
    await instance.ctx.authz.grant(
      eve.id,
      { kind: "space", orgId: orgId ?? "", spaceId: spaceId ?? "" },
      "viewer",
    );
    expect((await outsider.call("GET", space)).status).toBe(200);
    const write = await outsider.call(
      "PATCH",
      `${space}/pages/${page.page.id}`,
      { title: "X" },
    );
    expect(write.status).toBe(403);
    expect((await outsider.call("GET", `${space}/plugins`)).status).toBe(403);
  });

  it("duplicates a page and restores deleted pages", async () => {
    const instance = await boot();
    const admin = await login(instance);
    const space = await setUpSpace(admin);
    const parent = await admin.json<PageResponse>("POST", `${space}/pages`, {
      title: "Guide",
    });
    const child = await admin.json<PageResponse>("POST", `${space}/pages`, {
      title: "Step",
      parent: parent.page.id,
    });
    const copy = await admin.json<{
      page: { id: string; title: string; body: BlockNode };
    }>("POST", `${space}/pages`, {
      title: "Guide (copy)",
      copyOf: parent.page.id,
      order: 0.5,
    });
    expect(copy.page).toMatchObject({ title: "Guide (copy)", order: 0.5 });
    expect(copy.page.body.id).not.toBe(parent.page.body?.id);

    const deleted = await admin.json<{ removed: string[]; before: string }>(
      "DELETE",
      `${space}/pages/${parent.page.id}`,
    );
    expect(deleted.removed.toSorted()).toEqual(
      [parent.page.id, child.page.id].toSorted(),
    );
    await admin.json("POST", `${space}/pages/restore`, {
      from: deleted.before,
      ids: deleted.removed,
    });
    const { pages } = await admin.json<{ pages: { title: string }[] }>(
      "GET",
      space,
    );
    expect(pages.map((each) => each.title).toSorted()).toEqual([
      "Guide",
      "Guide (copy)",
      "Step",
    ]);
  });

  it("renames and deletes spaces and orgs", async () => {
    const instance = await boot();
    const admin = await login(instance);
    const space = await setUpSpace(admin);
    const [, , , orgId] = space.split("/");
    const org = `/api/orgs/${orgId}`;

    const renamed = await admin.json<{ space: Record<string, unknown> }>(
      "PATCH",
      space,
      { name: "Guides", description: "How we work." },
    );
    expect(renamed.space).toMatchObject({
      slug: "docs",
      name: "Guides",
      description: "How we work.",
    });
    expect(
      (await admin.call("PATCH", space, { slug: "Bad Slug" })).status,
    ).toBe(400);
    expect(
      (await admin.json<{ org: unknown }>("PATCH", org, { name: "Acme Inc" }))
        .org,
    ).toMatchObject({ slug: "acme", name: "Acme Inc" });

    const { token } = await client(instance).json<{ token: string }>(
      "POST",
      "/api/auth/dev-login",
      { email: "eve@example.com" },
    );
    const eve = await instance.ctx.identity.authenticate(token);
    if (!eve) throw new Error("expected a user");
    await instance.ctx.authz.revoke(eve.id, { kind: "instance" });
    await instance.ctx.authz.grant(
      eve.id,
      { kind: "org", orgId: orgId ?? "" },
      "admin",
    );
    const orgAdmin = client(instance, token);
    expect((await orgAdmin.call("DELETE", org)).status).toBe(403);

    expect((await orgAdmin.call("DELETE", space)).status).toBe(204);
    expect((await admin.call("GET", space)).status).toBe(404);
    expect(
      (await admin.json<{ spaces: unknown[] }>("GET", org)).spaces,
    ).toEqual([]);

    expect((await admin.call("DELETE", org)).status).toBe(204);
    expect((await admin.call("GET", org)).status).toBe(404);
    expect(await admin.json("GET", "/api/orgs")).toEqual({ orgs: [] });
  });

  it("lists editor entries of the plugins enabled in a space", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);
    const org = space.split("/spaces/")[0] ?? "";

    expect(await api.json("GET", `${space}/frontend`)).toEqual({ editors: [] });

    await api.json("PUT", `${org}/plugins`, {
      plugin: "@test/browser",
      enabled: true,
    });
    expect(await api.json("GET", `${space}/frontend`)).toEqual({
      editors: [
        {
          name: "@test/browser",
          url: "/_plugins/%40test%2Fbrowser/editor/index.js",
        },
      ],
    });

    const { plugins } = await api.json<{ plugins: unknown[] }>(
      "PUT",
      `${space}/plugins`,
      { plugin: "@test/browser", enabled: false },
    );
    expect(plugins).toEqual([
      {
        name: "@test/browser",
        version: "0.0.1",
        hasEditor: true,
        enabled: false,
        inherited: true,
      },
    ]);
    expect(await api.json("GET", `${space}/frontend`)).toEqual({ editors: [] });

    const unknown = await api.call("PUT", `${space}/plugins`, {
      plugin: "@test/nope",
      enabled: true,
    });
    expect(unknown.status).toBe(404);
  });

  it("lists editor entries of the plugins enabled in an organization", async () => {
    const api = await login(await boot());
    const space = await setUpSpace(api);
    const org = space.split("/spaces/")[0] ?? "";

    expect(await api.json("GET", `${org}/frontend`)).toEqual({ editors: [] });
    await api.json("PUT", `${org}/plugins`, {
      plugin: "@test/browser",
      enabled: true,
    });
    expect(await api.json("GET", `${org}/frontend`)).toEqual({
      editors: [
        {
          name: "@test/browser",
          url: "/_plugins/%40test%2Fbrowser/editor/index.js",
        },
      ],
    });
    expect((await api.call("GET", "/api/orgs/nope/frontend")).status).toBe(404);
  });

  it("lists editor entries of every installed plugin for full-page apps", async () => {
    const instance = await boot();
    expect((await client(instance).call("GET", "/api/frontend")).status).toBe(
      401,
    );
    const api = await login(instance);
    const space = await setUpSpace(api);
    await api.json("PUT", `${space}/plugins`, {
      plugin: "@test/browser",
      enabled: false,
    });
    expect(await api.json("GET", "/api/frontend")).toEqual({
      editors: [
        {
          name: "@test/browser",
          url: "/_plugins/%40test%2Fbrowser/editor/index.js",
        },
      ],
    });

    await instance.ctx.installations.uninstall("@test/browser");
    expect(await api.json("GET", "/api/frontend")).toEqual({ editors: [] });
  });
});

const get = (instance: Instance, path: string, accept = "*/*") =>
  instance.fetch(
    new Request(`http://localhost${path}`, { headers: { accept } }),
  );

describe("frontend", () => {
  it("serves the app shell with the host and plugin import map", async () => {
    const instance = await boot();
    const response = await get(instance, "/orgs/x", "text/html");
    const html = await response.text();
    const map = /<script type="importmap">(.*?)<\/script>/.exec(html)?.[1];
    expect(JSON.parse(map ?? "null")).toEqual({
      imports: {
        react: "/_app/vendor/react.js",
        "@test/browser-lib": "/_plugins/%40test%2Fbrowser/lib.js",
      },
    });
    expect(html.indexOf("importmap")).toBeLessThan(html.indexOf("main.js"));
  });

  it("serves app and plugin browser files and nothing else", async () => {
    const instance = await boot();
    const main = await get(instance, "/_app/main.js");
    expect(main.status).toBe(200);
    expect(main.headers.get("content-type")).toContain("text/javascript");
    expect(
      (await get(instance, "/_plugins/%40test%2Fbrowser/editor/index.js"))
        .status,
    ).toBe(200);

    for (const path of [
      "/_plugins/%40test%2Fbrowser/../server-only.txt",
      "/_plugins/%40test%2Fbrowser/%2e%2e/server-only.txt",
      "/_plugins/%40test%2Fbrowser/%2e%2e/docleus.plugin.json",
      "/_plugins/%40test%2Fnope/lib.js",
      "/_app/%2e%2e/browser/public/lib.js",
      "/_plugins/%40test%2Fbrowser/%E0%A4%A",
      "/missing.js",
    ]) {
      expect((await get(instance, path)).status, path).toBe(404);
    }
  });
});
