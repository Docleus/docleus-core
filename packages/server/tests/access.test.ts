import type { Instance } from "../src/index.ts";
import { afterEach, describe, expect, it } from "vitest";
import { account, bootWith, client, type Account } from "./helpers.ts";

const instances: Instance[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

const PUBLIC_ROUTES = [
  "GET /api/auth/methods",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/signup",
  "GET /api/setup",
  "POST /api/setup",
  "GET /api/invitations/:token",
];

describe("authentication", () => {
  it("answers 401 without credentials on every route that is not public", async () => {
    const instance = await boot();
    const routes = instance.ctx.http.routes();
    expect(
      routes
        .filter((route) => route.isPublic)
        .map((route) => `${route.method} ${route.path}`)
        .toSorted(),
    ).toEqual(PUBLIC_ROUTES.toSorted());

    const anonymous = client(instance);
    const statuses = [];
    for (const route of routes.filter((candidate) => !candidate.isPublic)) {
      const path = route.path.replace(/:\w+/g, "x");
      const body = route.method === "GET" ? undefined : {};
      const response = await anonymous.call(route.method, path, body);
      statuses.push([`${route.method} ${route.path}`, response.status]);
    }
    expect(statuses.length).toBeGreaterThan(20);
    expect(statuses.filter(([, status]) => status !== 401)).toEqual([]);
  });

  it("answers 401 to an unknown or ended session", async () => {
    const instance = await boot();
    const ada = await account(instance, "ada@example.com");
    await instance.ctx.identity.logout(ada.token);
    expect((await ada.api.call("GET", "/api/me")).status).toBe(401);
    expect(
      (
        await client(instance, { cookie: "docleus_session=nope" }).call(
          "GET",
          "/api/me",
        )
      ).status,
    ).toBe(401);
  });
});

interface World {
  owner: Account;
  orgAdmin: Account;
  member: Account;
  viewer: Account;
  outsider: Account;
  orgPath: string;
  spacePath: string;
  pageId: string;
}

async function world(instance: Instance): Promise<World> {
  const owner = await account(instance, "owner@example.com", { isAdmin: true });
  const { org } = await owner.api.json<{ org: { id: string } }>(
    "POST",
    "/api/orgs",
    { slug: "acme", name: "Acme" },
  );
  const orgPath = `/api/orgs/${org.id}`;
  const { space } = await owner.api.json<{ space: { id: string } }>(
    "POST",
    `${orgPath}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  const spacePath = `${orgPath}/spaces/${space.id}`;
  const { page } = await owner.api.json<{ page: { id: string } }>(
    "POST",
    `${spacePath}/pages`,
    { title: "Intro" },
  );
  const orgScope = { kind: "org", orgId: org.id } as const;
  const orgAdmin = await account(instance, "org-admin@example.com");
  await instance.ctx.authz.grant(orgAdmin.id, orgScope, "admin");
  const member = await account(instance, "member@example.com");
  await instance.ctx.authz.grant(member.id, orgScope, "member");
  const viewer = await account(instance, "viewer@example.com");
  await instance.ctx.authz.grant(
    viewer.id,
    { kind: "space", orgId: org.id, spaceId: space.id },
    "viewer",
  );
  const outsider = await account(instance, "outsider@example.com");
  return {
    owner,
    orgAdmin,
    member,
    viewer,
    outsider,
    orgPath,
    spacePath,
    pageId: page.id,
  };
}

type Case = [
  description: string,
  who: (world: World) => Account,
  method: string,
  path: (world: World) => string,
  body?: unknown,
];

const FORBIDDEN: Case[] = [
  [
    "a non-admin creates an org",
    (w) => w.orgAdmin,
    "POST",
    () => "/api/orgs",
    { slug: "x", name: "X" },
  ],
  ["a non-admin lists users", (w) => w.member, "GET", () => "/api/users"],
  [
    "a non-admin makes someone admin",
    (w) => w.orgAdmin,
    "PUT",
    (w) => `/api/users/${w.orgAdmin.id}/admin`,
    { isAdmin: true },
  ],
  ["a non-member reads an org", (w) => w.outsider, "GET", (w) => w.orgPath],
  [
    "a non-member lists org members",
    (w) => w.outsider,
    "GET",
    (w) => `${w.orgPath}/members`,
  ],
  ["a non-member reads a space", (w) => w.outsider, "GET", (w) => w.spacePath],
  [
    "a member changes a role",
    (w) => w.member,
    "PUT",
    (w) => `${w.orgPath}/members/${w.viewer.id}`,
    { role: "member" },
  ],
  [
    "a member removes another member",
    (w) => w.member,
    "DELETE",
    (w) => `${w.orgPath}/members/${w.orgAdmin.id}`,
  ],
  [
    "a member lists invitations",
    (w) => w.member,
    "GET",
    (w) => `${w.orgPath}/invitations`,
  ],
  [
    "a member invites",
    (w) => w.member,
    "POST",
    (w) => `${w.orgPath}/invitations`,
    { role: "member" },
  ],
  [
    "a member creates a space",
    (w) => w.member,
    "POST",
    (w) => `${w.orgPath}/spaces`,
    { slug: "x", name: "X" },
  ],
  [
    "a member writes a page",
    (w) => w.member,
    "POST",
    (w) => `${w.spacePath}/pages`,
    { title: "X" },
  ],
  [
    "a member lists space members",
    (w) => w.member,
    "GET",
    (w) => `${w.spacePath}/members`,
  ],
  [
    "an org admin grants the owner role",
    (w) => w.orgAdmin,
    "PUT",
    (w) => `${w.orgPath}/members/${w.member.id}`,
    { role: "owner" },
  ],
  [
    "an org admin removes an owner",
    (w) => w.orgAdmin,
    "DELETE",
    (w) => `${w.orgPath}/members/${w.owner.id}`,
  ],
  [
    "an org admin invites an owner",
    (w) => w.orgAdmin,
    "POST",
    (w) => `${w.orgPath}/invitations`,
    { role: "owner" },
  ],
  [
    "a space viewer creates a page",
    (w) => w.viewer,
    "POST",
    (w) => `${w.spacePath}/pages`,
    { title: "X" },
  ],
  [
    "a space viewer renames a page",
    (w) => w.viewer,
    "PATCH",
    (w) => `${w.spacePath}/pages/${w.pageId}`,
    { title: "X" },
  ],
  [
    "a space viewer deletes a page",
    (w) => w.viewer,
    "DELETE",
    (w) => `${w.spacePath}/pages/${w.pageId}`,
  ],
  [
    "a space viewer grants a space role",
    (w) => w.viewer,
    "PUT",
    (w) => `${w.spacePath}/members/${w.outsider.id}`,
    { role: "editor" },
  ],
  [
    "a space viewer lists org invitations",
    (w) => w.viewer,
    "GET",
    (w) => `${w.orgPath}/invitations`,
  ],
];

describe("authorization", () => {
  it.each(FORBIDDEN)(
    "answers 403 when %s",
    async (_, who, method, path, body) => {
      const instance = await boot();
      const w = await world(instance);
      const response = await who(w).api.call(method, path(w), body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: expect.any(String) });
    },
  );

  it("lets each role do what it may", async () => {
    const instance = await boot();
    const w = await world(instance);
    expect((await w.member.api.call("GET", w.spacePath)).status).toBe(200);
    expect((await w.viewer.api.call("GET", w.orgPath)).status).toBe(200);
    expect(
      (await w.viewer.api.call("GET", `${w.spacePath}/pages/${w.pageId}`))
        .status,
    ).toBe(200);
    expect(
      (await w.orgAdmin.api.call("GET", `${w.orgPath}/invitations`)).status,
    ).toBe(200);
    expect(
      (await w.orgAdmin.api.call("GET", `${w.spacePath}/members`)).status,
    ).toBe(200);
  });
});
