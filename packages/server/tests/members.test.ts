import type { Instance } from "../src/index.ts";
import { DefaultQueryExecutor } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  account,
  bootWith,
  client,
  cookieOf,
  fakeMailer,
  type Account,
} from "./helpers.ts";

const instances: Instance[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

interface Members {
  members: {
    user: { id: string; email: string; name: string };
    role: string;
  }[];
}

async function withOrg(options: Parameters<typeof boot>[0] = {}) {
  const instance = await boot(options);
  const admin = await account(instance, "admin@example.com", { isAdmin: true });
  const { org } = await admin.api.json<{ org: { id: string; name: string } }>(
    "POST",
    "/api/orgs",
    { slug: "acme", name: "Acme" },
  );
  const { space } = await admin.api.json<{ space: { id: string } }>(
    "POST",
    `/api/orgs/${org.id}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  return {
    instance,
    admin,
    org,
    orgPath: `/api/orgs/${org.id}`,
    spacePath: `/api/orgs/${org.id}/spaces/${space.id}`,
  };
}

async function member(
  instance: Instance,
  orgId: string,
  email: string,
  role: "owner" | "admin" | "member",
): Promise<Account> {
  const user = await account(instance, email);
  await instance.ctx.authz.grant(user.id, { kind: "org", orgId }, role);
  return user;
}

describe("org members", () => {
  it("makes the creator of an org its owner and lists members by email", async () => {
    const { instance, admin, org, orgPath } = await withOrg();
    await member(instance, org.id, "zoe@example.com", "member");
    await member(instance, org.id, "bob@example.com", "admin");

    const { members } = await admin.api.json<Members>(
      "GET",
      `${orgPath}/members`,
    );
    expect(members.map(({ user, role }) => [user.email, role])).toEqual([
      ["admin@example.com", "owner"],
      ["bob@example.com", "admin"],
      ["zoe@example.com", "member"],
    ]);
    expect(Object.keys(members[0]?.user ?? {}).toSorted()).toEqual([
      "email",
      "id",
      "name",
    ]);
  });

  it("lets org admins change roles but keeps the owner role to owners", async () => {
    const { instance, org, orgPath } = await withOrg();
    const bob = await member(instance, org.id, "bob@example.com", "admin");
    const zoe = await member(instance, org.id, "zoe@example.com", "member");

    const promoted = await bob.api.call("PUT", `${orgPath}/members/${zoe.id}`, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      member: { user: { email: "zoe@example.com" }, role: "admin" },
    });

    const toOwner = await bob.api.call("PUT", `${orgPath}/members/${zoe.id}`, {
      role: "owner",
    });
    expect(toOwner.status).toBe(403);

    const invalid = await bob.api.call("PUT", `${orgPath}/members/${zoe.id}`, {
      role: "editor",
    });
    expect(invalid.status).toBe(400);

    const missing = await bob.api.call("PUT", `${orgPath}/members/nobody`, {
      role: "member",
    });
    expect(missing.status).toBe(404);
  });

  it("never leaves an org without an owner", async () => {
    const { instance, admin, org, orgPath } = await withOrg();

    const demote = await admin.api.call(
      "PUT",
      `${orgPath}/members/${admin.id}`,
      { role: "admin" },
    );
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: "members/last-owner" });
    const leave = await admin.api.call(
      "DELETE",
      `${orgPath}/members/${admin.id}`,
    );
    expect(leave.status).toBe(409);

    const ann = await member(instance, org.id, "ann@example.com", "member");
    await admin.api.json("PUT", `${orgPath}/members/${ann.id}`, {
      role: "owner",
    });
    expect(
      (await admin.api.call("DELETE", `${orgPath}/members/${admin.id}`)).status,
    ).toBe(204);
    expect(
      await instance.ctx.authz.roleAt(admin.id, { kind: "org", orgId: org.id }),
    ).toBeUndefined();
  });

  it("lets a member leave and drops their space grants in the org", async () => {
    const { instance, org, orgPath, spacePath } = await withOrg();
    const zoe = await member(instance, org.id, "zoe@example.com", "member");
    const spaceId = spacePath.split("/")[5] ?? "";
    await instance.ctx.authz.grant(
      zoe.id,
      { kind: "space", orgId: org.id, spaceId },
      "editor",
    );

    const bob = await member(instance, org.id, "bob@example.com", "member");
    expect(
      (await bob.api.call("DELETE", `${orgPath}/members/${zoe.id}`)).status,
    ).toBe(403);

    expect(
      (await zoe.api.call("DELETE", `${orgPath}/members/${zoe.id}`)).status,
    ).toBe(204);
    expect(await instance.ctx.authz.listUserGrants(zoe.id)).toEqual([]);
    expect((await zoe.api.call("GET", orgPath)).status).toBe(403);
  });

  it("only lets owners remove an owner", async () => {
    const { instance, admin, org, orgPath } = await withOrg();
    const bob = await member(instance, org.id, "bob@example.com", "admin");
    const removal = await bob.api.call(
      "DELETE",
      `${orgPath}/members/${admin.id}`,
    );
    expect(removal.status).toBe(403);
  });
});

interface Created {
  invitation: { id: string; email: string | null; role: string };
  url: string;
  emailed: boolean;
}

const tokenOf = (created: Created) => created.url.split("/").at(-1) ?? "";

describe("invitations", () => {
  it("creates, emails, lists and revokes org invitations", async () => {
    const mailer = fakeMailer();
    const { instance, admin, orgPath } = await withOrg({
      mailer,
      publicUrl: "https://docs.example.com/",
    });

    const response = await admin.api.call("POST", `${orgPath}/invitations`, {
      email: "New@Example.com",
      role: "member",
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as Created;
    expect(created.invitation).toMatchObject({
      email: "new@example.com",
      role: "member",
    });
    expect(created.url).toMatch(
      /^https:\/\/docs\.example\.com\/invitations\/[\w-]+$/,
    );
    expect(created.emailed).toBe(true);
    expect(mailer.sent).toEqual([
      expect.objectContaining({ to: "new@example.com" }),
    ]);
    expect(mailer.sent[0]?.text).toContain(created.url);

    const link = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { role: "admin" },
    );
    expect(link.emailed).toBe(false);
    expect(mailer.sent).toHaveLength(1);

    const { invitations } = await admin.api.json<{
      invitations: Record<string, unknown>[];
    }>("GET", `${orgPath}/invitations`);
    expect(invitations.map(({ email, role }) => [email, role])).toEqual([
      ["new@example.com", "member"],
      [null, "admin"],
    ]);
    expect(Object.keys(invitations[0] ?? {}).toSorted()).toEqual([
      "createdAt",
      "email",
      "expiresAt",
      "id",
      "role",
    ]);

    const revoke = await admin.api.call(
      "DELETE",
      `${orgPath}/invitations/${created.invitation.id}`,
    );
    expect(revoke.status).toBe(204);
    const gone = await client(instance).call(
      "GET",
      `/api/invitations/${tokenOf(created)}`,
    );
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: "invitations/not-found" });
    expect(
      (
        await admin.api.call(
          "DELETE",
          `${orgPath}/invitations/${created.invitation.id}`,
        )
      ).status,
    ).toBe(404);
  });

  it("still creates the invitation when the email fails, and links to the request origin", async () => {
    const mailer = fakeMailer();
    mailer.isFailing = true;
    const { admin, orgPath } = await withOrg({ mailer });
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { email: "new@example.com", role: "member" },
    );
    expect(created.emailed).toBe(false);
    expect(created.url).toMatch(/^http:\/\/localhost\/invitations\//);
  });

  it("keeps owner invitations to owners", async () => {
    const { instance, org, orgPath } = await withOrg();
    const bob = await member(instance, org.id, "bob@example.com", "admin");
    const response = await bob.api.call("POST", `${orgPath}/invitations`, {
      role: "owner",
    });
    expect(response.status).toBe(403);
    expect(
      (
        await bob.api.call("POST", `${orgPath}/invitations`, {
          role: "admin",
        })
      ).status,
    ).toBe(201);
  });

  it("describes an invitation to anyone with its link", async () => {
    const { instance, admin, org, orgPath } = await withOrg();
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { email: "new@example.com", role: "admin" },
    );
    const anonymous = client(instance);
    const response = await anonymous.json(
      "GET",
      `/api/invitations/${tokenOf(created)}`,
    );
    expect(response).toEqual({
      org: { id: org.id, name: "Acme" },
      role: "admin",
      email: "new@example.com",
      expiresAt: expect.any(Number),
    });
    expect(
      (await anonymous.call("GET", "/api/invitations/not-a-token")).status,
    ).toBe(404);
  });
});

describe("signup by invitation", () => {
  it("creates the invited user with the invited role, once", async () => {
    const { instance, admin, orgPath } = await withOrg();
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { email: "new@example.com", role: "admin" },
    );
    const anonymous = client(instance);
    const response = await anonymous.call("POST", "/api/auth/signup", {
      invitation: tokenOf(created),
      name: "New",
      password: "correct horse",
      email: "other@example.com",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ user: { email: "new@example.com" } });
    expect(body).not.toHaveProperty("token");

    const session = client(instance, { cookie: cookieOf(response) });
    const { members } = await session.json<Members>(
      "GET",
      `${orgPath}/members`,
    );
    expect(
      members.find(({ user }) => user.email === "new@example.com")?.role,
    ).toBe("admin");
    expect((await session.call("GET", `${orgPath}/invitations`)).status).toBe(
      200,
    );

    const again = await anonymous.call("POST", "/api/auth/signup", {
      invitation: tokenOf(created),
      name: "Eve",
      password: "correct horse",
      email: "eve@example.com",
    });
    expect(again.status).toBe(404);
    expect(await instance.ctx.identity.findUserByEmail("eve@example.com")).toBe(
      undefined,
    );
  });

  it("takes the email from the request for a link invitation", async () => {
    const { instance, admin, orgPath } = await withOrg();
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { role: "member" },
    );
    const anonymous = client(instance);
    const missing = await anonymous.call("POST", "/api/auth/signup", {
      invitation: tokenOf(created),
      name: "New",
      password: "correct horse",
    });
    expect(missing.status).toBe(400);

    const taken = await anonymous.call("POST", "/api/auth/signup", {
      invitation: tokenOf(created),
      name: "Admin",
      password: "correct horse",
      email: "admin@example.com",
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "identity/email-taken" });

    const response = await anonymous.call("POST", "/api/auth/signup", {
      invitation: tokenOf(created),
      name: "New",
      password: "correct horse",
      email: "new@example.com",
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      user: { email: "new@example.com" },
    });
  });
});

describe("accepting an invitation", () => {
  it("grants the invited role to the signed-in user", async () => {
    const { instance, admin, org, orgPath } = await withOrg();
    const zoe = await account(instance, "zoe@example.com");
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { role: "member" },
    );
    const accepted = await zoe.api.call(
      "POST",
      `/api/invitations/${tokenOf(created)}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      org: { id: org.id, name: "Acme" },
    });
    expect(
      await instance.ctx.authz.roleAt(zoe.id, { kind: "org", orgId: org.id }),
    ).toBe("member");
    expect(
      (
        await zoe.api.call(
          "POST",
          `/api/invitations/${tokenOf(created)}/accept`,
        )
      ).status,
    ).toBe(404);
  });

  it("never lowers the role of an existing member", async () => {
    const { instance, admin, org, orgPath } = await withOrg();
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { role: "member" },
    );
    await admin.api.json("POST", `/api/invitations/${tokenOf(created)}/accept`);
    expect(
      await instance.ctx.authz.roleAt(admin.id, { kind: "org", orgId: org.id }),
    ).toBe("owner");
  });

  it("refuses an invitation meant for another email", async () => {
    const { instance, admin, orgPath } = await withOrg();
    const zoe = await account(instance, "zoe@example.com");
    const created = await admin.api.json<Created>(
      "POST",
      `${orgPath}/invitations`,
      { email: "bob@example.com", role: "member" },
    );
    const response = await zoe.api.call(
      "POST",
      `/api/invitations/${tokenOf(created)}/accept`,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "identity/invitation-email-mismatch",
    });
    expect(
      (
        await client(instance).call(
          "GET",
          `/api/invitations/${tokenOf(created)}`,
        )
      ).status,
    ).toBe(200);
  });
});

describe("space members", () => {
  it("lets space managers grant, list and revoke space roles", async () => {
    const { instance, admin, org, spacePath } = await withOrg();
    const zoe = await account(instance, "zoe@example.com");
    const bob = await member(instance, org.id, "bob@example.com", "member");

    expect((await zoe.api.call("GET", `${spacePath}/members`)).status).toBe(
      403,
    );
    expect((await bob.api.call("GET", `${spacePath}/members`)).status).toBe(
      403,
    );

    const granted = await admin.api.call(
      "PUT",
      `${spacePath}/members/${zoe.id}`,
      { role: "editor" },
    );
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      member: { user: { email: "zoe@example.com" }, role: "editor" },
    });
    expect(
      (
        await admin.api.call("PUT", `${spacePath}/members/${zoe.id}`, {
          role: "owner",
        })
      ).status,
    ).toBe(400);

    const { members } = await admin.api.json<Members>(
      "GET",
      `${spacePath}/members`,
    );
    expect(members.map(({ user, role }) => [user.email, role])).toEqual([
      ["zoe@example.com", "editor"],
    ]);
    expect((await zoe.api.call("GET", spacePath)).status).toBe(200);

    expect(
      (await admin.api.call("DELETE", `${spacePath}/members/${zoe.id}`)).status,
    ).toBe(204);
    expect((await zoe.api.call("GET", spacePath)).status).toBe(403);
  });
});

describe("instance users", () => {
  it("lists users and toggles instance admins, keeping at least one", async () => {
    const { instance, admin } = await withOrg();
    const zoe = await account(instance, "zoe@example.com");

    expect((await zoe.api.call("GET", "/api/users")).status).toBe(403);
    const { users } = await admin.api.json<{ users: unknown[] }>(
      "GET",
      "/api/users",
    );
    expect(users).toEqual([
      {
        id: admin.id,
        email: "admin@example.com",
        name: "admin",
        isAdmin: true,
      },
      { id: zoe.id, email: "zoe@example.com", name: "zoe", isAdmin: false },
    ]);

    const last = await admin.api.call("PUT", `/api/users/${admin.id}/admin`, {
      isAdmin: false,
    });
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({ code: "users/last-admin" });

    expect(
      await admin.api.json("PUT", `/api/users/${zoe.id}/admin`, {
        isAdmin: true,
      }),
    ).toMatchObject({ user: { id: zoe.id, isAdmin: true } });
    expect(
      await zoe.api.json("PUT", `/api/users/${admin.id}/admin`, {
        isAdmin: false,
      }),
    ).toMatchObject({ user: { id: admin.id, isAdmin: false } });
    expect((await admin.api.call("GET", "/api/users")).status).toBe(403);
    expect(
      (await zoe.api.call("PUT", "/api/users/nobody/admin", { isAdmin: true }))
        .status,
    ).toBe(404);
  });
});

describe("org listing", () => {
  it("lists the orgs a user can read, including through a space grant", async () => {
    const { instance, admin, org, spacePath } = await withOrg();
    await admin.api.json("POST", "/api/orgs", { slug: "other", name: "Other" });
    const zoe = await account(instance, "zoe@example.com");
    expect(await zoe.api.json("GET", "/api/orgs")).toEqual({ orgs: [] });

    const spaceId = spacePath.split("/").at(-1) ?? "";
    await instance.ctx.authz.grant(
      zoe.id,
      { kind: "space", orgId: org.id, spaceId },
      "viewer",
    );
    const { orgs } = await zoe.api.json<{ orgs: { id: string }[] }>(
      "GET",
      "/api/orgs",
    );
    expect(orgs.map(({ id }) => id)).toEqual([org.id]);
  });
});

// Every query of every dialect goes through Kysely's executor.
async function queriesOf(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(DefaultQueryExecutor.prototype, "executeQuery");
  try {
    await fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

/** Queries of `GET path` after `grow` added rows once and then again. */
async function queriesAsRowsGrow(
  api: Account["api"],
  path: string,
  grow: (round: number) => Promise<void>,
): Promise<number[]> {
  const counts = [];
  for (const round of [0, 1]) {
    await grow(round);
    await api.json("GET", path);
    counts.push(await queriesOf(() => api.json("GET", path)));
  }
  return counts;
}

describe("listing queries", () => {
  it("does not grow with the members of an org or a space", async () => {
    const { instance, admin, org, orgPath, spacePath } = await withOrg();
    const spaceId = spacePath.split("/").at(-1) ?? "";
    const grow = (list: string) => async (round: number) => {
      for (let index = 0; index < 4; index++) {
        const user = await member(
          instance,
          org.id,
          `${list}${round}-${index}@example.com`,
          "member",
        );
        await instance.ctx.authz.grant(
          user.id,
          { kind: "space", orgId: org.id, spaceId },
          "viewer",
        );
      }
    };
    const orgCounts = await queriesAsRowsGrow(
      admin.api,
      `${orgPath}/members`,
      grow("org"),
    );
    expect(orgCounts[1]).toBe(orgCounts[0]);
    const spaceCounts = await queriesAsRowsGrow(
      admin.api,
      `${spacePath}/members`,
      grow("space"),
    );
    expect(spaceCounts[1]).toBe(spaceCounts[0]);
  });

  it("does not grow with the instance's users", async () => {
    const instance = await boot();
    const admin = await account(instance, "admin@example.com", {
      isAdmin: true,
    });
    const counts = await queriesAsRowsGrow(admin.api, "/api/users", (round) =>
      Promise.all(
        [0, 1, 2, 3].map((index) =>
          account(instance, `u${round}-${index}@example.com`, {
            isAdmin: index === 0,
          }),
        ),
      ).then(() => undefined),
    );
    expect(counts[1]).toBe(counts[0]);
  });

  it("does not grow with the orgs or spaces a user may read", async () => {
    const { instance, admin, org, orgPath } = await withOrg();
    const zoe = await account(instance, "zoe@example.com");
    await instance.ctx.authz.grant(
      zoe.id,
      { kind: "org", orgId: org.id },
      "member",
    );
    const orgCounts = await queriesAsRowsGrow(
      zoe.api,
      "/api/orgs",
      async (round) => {
        for (let index = 0; index < 4; index++) {
          const { org: created } = await admin.api.json<{
            org: { id: string };
          }>("POST", "/api/orgs", {
            slug: `org-${round}-${index}`,
            name: "Org",
          });
          if (index % 2 === 0) {
            await instance.ctx.authz.grant(
              zoe.id,
              { kind: "org", orgId: created.id },
              "member",
            );
          }
        }
      },
    );
    expect(orgCounts[1]).toBe(orgCounts[0]);
    const spaceCounts = await queriesAsRowsGrow(
      zoe.api,
      orgPath,
      async (round) => {
        for (let index = 0; index < 4; index++) {
          await admin.api.json("POST", `${orgPath}/spaces`, {
            slug: `space-${round}-${index}`,
            name: "Space",
          });
        }
      },
    );
    expect(spaceCounts[1]).toBe(spaceCounts[0]);
  });
});
