import { PAGE_ENTRY_TYPE } from "@docleus/sdk";
import { testStorageLocation } from "@docleus/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createInstance, type Instance } from "../src/index.ts";
import { account, client, fixtures, ORIGIN } from "./helpers.ts";

const instances: Instance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

async function boot(plugins: { id: string; plugin: string }[]) {
  const instance = await createInstance({
    baseDir: fixtures,
    plugins,
    database: await testStorageLocation(),
    siteRuntimeDir: `${fixtures}site-runtime`,
    isDev: true,
  });
  instances.push(instance);
  return instance;
}

async function publishSite(instance: Instance): Promise<void> {
  const login = await instance.fetch(
    new Request(`${ORIGIN}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    }),
  );
  const { token } = (await login.json()) as { token: string };
  const admin = client(instance, { token });
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
  await instance.ctx.content.commit({
    spaceId: space.id,
    parent: undefined,
    put: {
      home: {
        type: PAGE_ENTRY_TYPE,
        title: "Home",
        parent: undefined,
        order: 0,
        fields: {},
        body: { id: "root", type: "doc", v: 1, attrs: {}, content: [] },
      },
    },
    message: "Initial",
  });
  const sites = `/api/orgs/${org.id}/sites`;
  const { site } = await admin.json<{ site: { id: string } }>("POST", sites, {
    slug: "docs",
    name: "Docs",
    spaces: [{ spaceId: space.id, path: "" }],
  });
  await admin.json("POST", `${sites}/${site.id}/publications`);
}

type MemoryBlobs = Instance["ctx"]["blobs"] & {
  readonly objects?: ReadonlyMap<string, Uint8Array>;
};

describe("core providers", () => {
  it("uses the blobs of a configured plugin whose manifest provides blobs", async () => {
    const instance = await boot([{ id: "blobs", plugin: "blobs-provider" }]);
    const blobs = instance.ctx.blobs as typeof instance.ctx.blobs & {
      readonly objects?: ReadonlyMap<string, Uint8Array>;
    };
    expect(blobs.objects).toBeInstanceOf(Map);

    await publishSite(instance);
    expect(blobs.objects?.size).toBeGreaterThan(0);
    const home = await instance.fetch(
      new Request(`${ORIGIN}/sites/acme/docs/`),
    );
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Home");
  });

  it("provides core blobs when no configured plugin provides them", async () => {
    const instance = await boot([{ id: "provider", plugin: "provider" }]);
    expect("objects" in instance.ctx.blobs).toBe(false);
    await publishSite(instance);
    const home = await instance.fetch(
      new Request(`${ORIGIN}/sites/acme/docs/`),
    );
    expect(home.status).toBe(200);
  });

  it("switches to the blobs of a plugin installed at runtime, and back on uninstall", async () => {
    const instance = await boot([{ id: "provider", plugin: "provider" }]);
    const admin = await account(instance, "root@example.com", {
      isAdmin: true,
    });
    expect("objects" in instance.ctx.blobs).toBe(false);

    const installed = await admin.api.call("POST", "/api/plugins", {
      type: "path",
      path: `${fixtures}blobs-provider`,
    });
    expect(installed.status).toBe(201);
    const blobs = instance.ctx.blobs as MemoryBlobs;
    expect(blobs.objects).toBeInstanceOf(Map);

    await publishSite(instance);
    expect(blobs.objects?.size).toBeGreaterThan(0);
    const home = await instance.fetch(
      new Request(`${ORIGIN}/sites/acme/docs/`),
    );
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Home");

    const removed = await admin.api.call(
      "DELETE",
      `/api/plugins/${encodeURIComponent("@test/blobs-provider")}`,
    );
    expect(removed.status).toBe(204);
    expect("objects" in instance.ctx.blobs).toBe(false);
    const stored = await instance.ctx.blobs.put(new Uint8Array([1, 2, 3]));
    expect(await instance.ctx.blobs.stat(stored.hash)).toMatchObject({
      size: 3,
    });
  });
});
