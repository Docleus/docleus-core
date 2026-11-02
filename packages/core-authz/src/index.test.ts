import { Context, type Fiber } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import {
  authzConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityService } from "@docleus/core-identity";
import { createAuthzService } from "./index.ts";
import type { AuthzService, IdentityService } from "@docleus/sdk";

// The conformance suite grants to made-up user ids, so its identity knows
// every id.
const everyUserExists = {
  async getUser(id: string) {
    return { id, email: `${id}@example.com`, name: id, hasPassword: false };
  },
} as unknown as IdentityService;

const fibers: Fiber[] = [];
async function freshAuthz(): Promise<AuthzService> {
  let authz!: AuthzService;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    ctx.provide("identity", everyUserExists);
    authz = createAuthzService(ctx);
  });
  fibers.push(fiber);
  return authz;
}
afterEach(async () => {
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

runConformanceSuite(authzConformanceSuite, freshAuthz);

describe("createAuthzService", () => {
  it("rejects an org scope with an invalid id", async () => {
    const authz = await freshAuthz();
    await expect(
      authz.grant("u1", { kind: "org", orgId: "bad id!" }, "admin"),
    ).rejects.toThrow();
  });
});

async function withIdentity() {
  let authz!: AuthzService;
  let identity!: IdentityService;
  let ctxRef!: Context;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    identity = createIdentityService(ctx);
    ctx.provide("identity", identity);
    authz = createAuthzService(ctx);
    ctxRef = ctx;
  });
  fibers.push(fiber);
  return { authz, identity, db: ctxRef.storage.db };
}

describe("users that no longer exist", () => {
  it("denies a deleted user despite their grants", async () => {
    const { authz, identity, db } = await withIdentity();
    const admin = await identity.createUser({
      email: "admin@example.com",
      name: "Admin",
    });
    const guest = await identity.createUser({
      email: "guest@example.com",
      name: "Guest",
    });
    await authz.grant(admin.id, { kind: "instance" }, "admin");
    await authz.grant(
      guest.id,
      { kind: "space", orgId: "o1", spaceId: "s1" },
      "viewer",
    );
    const asAdmin = { kind: "user", userId: admin.id } as const;
    const asGuest = { kind: "user", userId: guest.id } as const;
    expect(await authz.can(asAdmin, "manage", { kind: "instance" })).toBe(true);
    expect(await authz.can(asGuest, "read", { kind: "org", orgId: "o1" })).toBe(
      true,
    );

    await sql`delete from users`.execute(db);

    expect(await authz.can(asAdmin, "manage", { kind: "instance" })).toBe(
      false,
    );
    expect(
      await authz.can(asAdmin, "read", {
        kind: "space",
        orgId: "o1",
        spaceId: "s1",
      }),
    ).toBe(false);
    expect(await authz.can(asGuest, "read", { kind: "org", orgId: "o1" })).toBe(
      false,
    );
    expect(
      await authz.can(asGuest, "read", {
        kind: "space",
        orgId: "o1",
        spaceId: "s1",
      }),
    ).toBe(false);
  });
});

describe("stored role validation", () => {
  it("rejects a stored role it does not know instead of misreading it", async () => {
    let authz!: AuthzService;
    let ctxRef!: Context;
    const storageLocation = await testStorageLocation();
    const fiber = await new Context().plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      authz = createAuthzService(ctx);
      ctxRef = ctx;
    });
    fibers.push(fiber);
    await authz.grant("u1", { kind: "instance" }, "admin");
    await sql`update authz_grants set role = 'owner'`.execute(
      ctxRef.storage.db,
    );
    await expect(
      authz.can({ kind: "user", userId: "u1" }, "read", { kind: "instance" }),
    ).rejects.toMatchObject({ code: "authz/invalid-role" });
    await expect(
      authz.roleAt("u1", { kind: "instance" }),
    ).rejects.toMatchObject({ code: "authz/invalid-role" });
  });

  it("rejects a stored space role that only an org takes, also when reading the org", async () => {
    let authz!: AuthzService;
    let ctxRef!: Context;
    const storageLocation = await testStorageLocation();
    const fiber = await new Context().plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      authz = createAuthzService(ctx);
      ctxRef = ctx;
    });
    fibers.push(fiber);
    const scope = { kind: "space", orgId: "o1", spaceId: "s1" } as const;
    await authz.grant("u1", scope, "viewer");
    await sql`update authz_grants set role = 'member'`.execute(
      ctxRef.storage.db,
    );
    await expect(authz.listGrants(scope)).rejects.toMatchObject({
      code: "authz/invalid-role",
    });
    await expect(
      authz.can({ kind: "user", userId: "u1" }, "read", {
        kind: "org",
        orgId: "o1",
      }),
    ).rejects.toMatchObject({ code: "authz/invalid-role" });
  });

  it("rejects a stored scope key it cannot parse", async () => {
    let authz!: AuthzService;
    let ctxRef!: Context;
    const storageLocation = await testStorageLocation();
    const fiber = await new Context().plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      authz = createAuthzService(ctx);
      ctxRef = ctx;
    });
    fibers.push(fiber);
    await authz.grant("u1", { kind: "org", orgId: "o1" }, "member");
    await sql`update authz_grants set scope_key = 'org:o1:extra'`.execute(
      ctxRef.storage.db,
    );
    await expect(authz.listUserGrants("u1")).rejects.toMatchObject({
      code: "authz/invalid-scope",
    });
  });
});
