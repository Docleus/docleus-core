import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scopeKey } from "@docleus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETED_SCOPE_GRANTS } from "../src/deleted-scope-grants.ts";
import type { Instance } from "../src/index.ts";
import { account, bootWith, client } from "./helpers.ts";

const instances: Instance[] = [];
const directories: string[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setUp(options: Parameters<typeof boot>[0] = {}) {
  const instance = await boot(options);
  const admin = await account(instance, "admin@example.com", { isAdmin: true });
  const guest = await account(instance, "guest@example.com");
  const { ctx } = instance;
  const org = await ctx.content.createOrg({ slug: "acme", name: "Acme" });
  const space = await ctx.content.createSpace({
    orgId: org.id,
    slug: "docs",
    name: "Docs",
  });
  const orgScope = { kind: "org", orgId: org.id } as const;
  const spaceScope = {
    kind: "space",
    orgId: org.id,
    spaceId: space.id,
  } as const;
  await ctx.authz.grant(admin.id, orgScope, "owner");
  await ctx.authz.grant(guest.id, spaceScope, "viewer");
  const orgPath = `/api/orgs/${org.id}`;
  return {
    instance,
    ctx,
    admin,
    guest,
    orgScope,
    spaceScope,
    orgPath,
    spacePath: `${orgPath}/spaces/${space.id}`,
  };
}

describe("scope deletion", () => {
  it("removes a deleted space's grants before answering success", async () => {
    const { ctx, admin, guest, orgScope, spaceScope, orgPath, spacePath } =
      await setUp();
    expect((await guest.api.call("GET", `${orgPath}/members`)).status).toBe(
      200,
    );

    expect((await admin.api.call("DELETE", spacePath)).status).toBe(204);

    expect((await guest.api.call("GET", `${orgPath}/members`)).status).toBe(
      403,
    );
    expect((await guest.api.call("GET", orgPath)).status).toBe(403);
    expect(await ctx.authz.listGrants(spaceScope)).toEqual([]);
    expect(await ctx.authz.roleAt(admin.id, orgScope)).toBe("owner");
    expect(await guest.api.json("GET", "/api/orgs")).toEqual({ orgs: [] });
  });

  it("keeps grants for sibling spaces and direct organization members", async () => {
    const {
      instance,
      ctx,
      admin,
      guest,
      orgScope,
      spaceScope,
      orgPath,
      spacePath,
    } = await setUp();
    const sibling = await ctx.content.createSpace({
      orgId: orgScope.orgId,
      slug: "guides",
      name: "Guides",
    });
    const siblingScope = { ...spaceScope, spaceId: sibling.id };
    await ctx.authz.grant(guest.id, siblingScope, "editor");
    const member = await account(instance, "member@example.com");
    await ctx.authz.grant(member.id, orgScope, "member");

    expect((await admin.api.call("DELETE", spacePath)).status).toBe(204);

    expect(await ctx.authz.listGrants(spaceScope)).toEqual([]);
    expect(await ctx.authz.listUserGrants(guest.id)).toEqual([
      { userId: guest.id, scope: siblingScope, role: "editor" },
    ]);
    expect((await guest.api.call("GET", `${orgPath}/members`)).status).toBe(
      200,
    );
    expect(await ctx.authz.roleAt(member.id, orgScope)).toBe("member");
    expect((await member.api.call("GET", orgPath)).status).toBe(200);
  });

  it("removes organization and descendant grants while keeping other scopes", async () => {
    const { ctx, admin, guest, orgScope, spaceScope, orgPath } = await setUp();
    await ctx.authz.grant(guest.id, orgScope, "member");
    const sibling = await ctx.content.createSpace({
      orgId: orgScope.orgId,
      slug: "guides",
      name: "Guides",
    });
    const siblingScope = { ...spaceScope, spaceId: sibling.id };
    await ctx.authz.grant(guest.id, siblingScope, "editor");
    const otherOrg = await ctx.content.createOrg({
      slug: "other",
      name: "Other",
    });
    const otherScope = { kind: "org", orgId: otherOrg.id } as const;
    await ctx.authz.grant(guest.id, otherScope, "member");

    expect((await admin.api.call("DELETE", orgPath)).status).toBe(204);

    expect((await guest.api.call("GET", `${orgPath}/members`)).status).toBe(
      403,
    );
    for (const scope of [orgScope, spaceScope, siblingScope]) {
      expect(await ctx.authz.listGrants(scope)).toEqual([]);
    }
    expect(await ctx.authz.listUserGrants(guest.id)).toEqual([
      { userId: guest.id, scope: otherScope, role: "member" },
    ]);
    expect(await ctx.authz.roleAt(admin.id, { kind: "instance" })).toBe(
      "admin",
    );
    expect(
      (await guest.api.call("GET", `/api/orgs/${otherOrg.id}`)).status,
    ).toBe(200);
  });

  it("leaves grants intact when a deletion is forbidden", async () => {
    const { ctx, guest, orgScope, spaceScope, orgPath, spacePath } =
      await setUp();
    const before = await ctx.authz.listUserGrants(guest.id);
    for (const path of [spacePath, orgPath]) {
      expect((await guest.api.call("DELETE", path)).status).toBe(403);
    }
    expect(await ctx.authz.listUserGrants(guest.id)).toEqual(before);
    expect(
      await ctx.authz.can(
        { kind: "user", userId: guest.id },
        "read",
        spaceScope,
      ),
    ).toBe(true);
    expect(await ctx.content.getOrg(orgScope.orgId)).toBeDefined();
    expect(await ctx.content.listSpaces(orgScope.orgId)).toHaveLength(1);
  });

  it.each(["org", "space"] as const)(
    "reports a failed %s grant cleanup and retries it from the deletion log",
    async (kind) => {
      const { ctx, admin, guest, orgScope, spaceScope, orgPath, spacePath } =
        await setUp();
      await ctx.content.catchUp(DELETED_SCOPE_GRANTS);
      const revoke = vi
        .spyOn(ctx.authz, "revokeAll")
        .mockRejectedValue(new Error("grant storage unavailable"));
      try {
        const response = await admin.api.call(
          "DELETE",
          kind === "org" ? orgPath : spacePath,
        );
        expect(response.status).toBe(500);
        await expect(ctx.content.catchUp(DELETED_SCOPE_GRANTS)).rejects.toThrow(
          "grant storage unavailable",
        );
        expect(await ctx.authz.listGrants(spaceScope)).toHaveLength(1);
        if (kind === "org") {
          expect(await ctx.content.getOrg(orgScope.orgId)).toBeUndefined();
        }
      } finally {
        revoke.mockRestore();
      }

      await ctx.content.catchUp(DELETED_SCOPE_GRANTS);
      expect(await ctx.authz.listGrants(spaceScope)).toEqual([]);
      if (kind === "org") {
        expect(await ctx.authz.listGrants(orgScope)).toEqual([]);
      } else {
        expect(await ctx.authz.roleAt(admin.id, orgScope)).toBe("owner");
      }
      expect((await guest.api.call("GET", `${orgPath}/members`)).status).toBe(
        403,
      );
    },
  );

  it("replays legacy deletions before granting access on startup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "docleus-deletion-"));
    directories.push(dataDir);
    const { instance, ctx, guest, orgScope, spaceScope, orgPath } = await setUp(
      {
        dataDir,
      },
    );
    const deletedOrg = await ctx.content.createOrg({
      slug: "gone",
      name: "Gone",
    });
    const deletedOrgScope = { kind: "org", orgId: deletedOrg.id } as const;
    const otherSpace = await ctx.content.createSpace({
      orgId: deletedOrg.id,
      slug: "docs",
      name: "Docs",
    });
    const otherSpaceScope = {
      kind: "space",
      orgId: deletedOrg.id,
      spaceId: otherSpace.id,
    } as const;
    await ctx.content.deleteSpace(spaceScope.spaceId);
    await ctx.content.deleteOrg(deletedOrg.id);
    await ctx.content.catchUp(DELETED_SCOPE_GRANTS);
    await instance.dispose();
    instances.splice(instances.indexOf(instance), 1);

    const db = new DatabaseSync(join(dataDir, "docleus.db"));
    try {
      const insert = db.prepare(
        "INSERT INTO authz_grants (user_id, scope_key, role) VALUES (?, ?, ?)",
      );
      insert.run(guest.id, scopeKey(spaceScope), "viewer");
      insert.run(guest.id, scopeKey(deletedOrgScope), "member");
      insert.run(guest.id, scopeKey(otherSpaceScope), "editor");
      db.prepare("DELETE FROM projection_cursors WHERE name = ?").run(
        DELETED_SCOPE_GRANTS,
      );
    } finally {
      db.close();
    }

    const restarted = await boot({ dataDir });
    const api = client(restarted, { token: guest.token });
    expect((await api.call("GET", `${orgPath}/members`)).status).toBe(403);
    expect(await restarted.ctx.authz.listUserGrants(guest.id)).toEqual([]);
    expect(await restarted.ctx.content.getOrg(orgScope.orgId)).toBeDefined();
  });

  it("cleans up content-service deletions and can replay them again", async () => {
    const { ctx, guest, spaceScope, orgPath } = await setUp();
    await ctx.content.deleteSpace(spaceScope.spaceId);
    await ctx.content.catchUp(DELETED_SCOPE_GRANTS);
    expect(await ctx.authz.listUserGrants(guest.id)).toEqual([]);
    expect((await guest.api.call("GET", `${orgPath}/members`)).status).toBe(
      403,
    );
    await ctx.content.rebuild(DELETED_SCOPE_GRANTS);
    expect(await ctx.authz.listUserGrants(guest.id)).toEqual([]);
  });
});
