import { Context } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import {
  identityConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityService } from "./index.ts";
import { identityMigrations } from "./schema.ts";
import type { IdentityService, StorageService } from "@docleus/sdk";
import { sql, type Kysely } from "kysely";

// Each invariant gets its own fiber (see `freshIdentity`), tracked here so
// it can be disposed afterwards; the conformance suite's `T` is still
// `IdentityService`, matching every other package's conformance tests.
const fibers: import("@docleus/kernel").Fiber[] = [];

async function freshIdentity(): Promise<IdentityService> {
  let identity!: IdentityService;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    identity = createIdentityService(ctx);
  });
  fibers.push(fiber);
  return identity;
}

runConformanceSuite(identityConformanceSuite, freshIdentity);

afterEach(async () => {
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

describe("createIdentityService", () => {
  it("creates one user when two first logins with the same email race", async () => {
    const identity = await freshIdentity();
    identity.registerProvider("test", {
      authenticate: async () => ({ email: "race@example.com", name: "R" }),
    });
    const results = await Promise.all([
      identity.login("test", {}, { allowSignup: true }),
      identity.login("test", {}, { allowSignup: true }),
    ]);
    const users = await Promise.all(
      results.map((result) => {
        if (!result) throw new Error("expected a login");
        return identity.authenticate(result.token);
      }),
    );
    expect(users[0]?.id).toBeDefined();
    expect(users[0]?.id).toBe(users[1]?.id);
  });

  it("undoes provider registration when the owning plugin is disposed", async () => {
    const root = new Context();
    const storageLocation = await testStorageLocation();
    const storageFiber = await root.plugin((ctx: Context) =>
      ctx.provide("storage", createStorageService(ctx, storageLocation)),
    );
    let identity!: IdentityService;
    const providerFiber = await root.plugin({
      inject: ["storage"],
      apply: (ctx: Context) => {
        identity = createIdentityService(ctx);
        identity.registerProvider("plugin-owned", {
          authenticate: async () => ({ email: "a@example.com", name: "A" }),
        });
      },
    });
    expect(
      await identity.login("plugin-owned", {}, { allowSignup: true }),
    ).toBeDefined();

    await providerFiber.dispose();

    expect(await identity.login("plugin-owned", {})).toBeUndefined();

    await storageFiber.dispose();
  });

  it("stores neither session tokens nor passwords in the clear", async () => {
    let storage!: StorageService;
    let identity!: IdentityService;
    const storageLocation = await testStorageLocation();
    const fiber = await new Context().plugin((ctx: Context) => {
      storage = createStorageService(ctx, storageLocation);
      ctx.provide("storage", storage);
      identity = createIdentityService(ctx);
    });
    fibers.push(fiber);
    const user = await identity.createUser({
      email: "h@example.com",
      name: "H",
      password: "a secret password",
    });
    const token = await identity.createSession(user.id);
    const db = storage.db as Kysely<unknown>;
    const { rows: users } = await sql<{
      password_hash: string;
    }>`select password_hash from users`.execute(db);
    expect(users[0]?.password_hash).toMatch(/^\$argon2id\$/);
    const { rows: sessions } = await sql<{
      token_hash: string;
    }>`select token_hash from sessions`.execute(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.token_hash).not.toBe(token);
  });

  it("uses the injected clock for session and invitation expiry", async () => {
    let time = 1_000;
    let identity!: IdentityService;
    const storageLocation = await testStorageLocation();
    const fiber = await new Context().plugin((ctx: Context) => {
      ctx.provide("storage", createStorageService(ctx, storageLocation));
      identity = createIdentityService(ctx, { now: () => time });
    });
    fibers.push(fiber);
    const user = await identity.createUser({
      email: "c@example.com",
      name: "C",
    });
    const token = await identity.createSession(user.id, { ttlMs: 10 });
    const { invitation, token: invite } = await identity.createInvitation({
      data: null,
      ttlMs: 10,
    });
    expect(invitation).toMatchObject({ createdAt: 1_000, expiresAt: 1_010 });
    time = 1_009;
    expect(await identity.authenticate(token)).toBeDefined();
    expect(await identity.findInvitation(invite)).toBeDefined();
    time = 1_010;
    expect(await identity.authenticate(token)).toBeUndefined();
    expect(await identity.findInvitation(invite)).toBeUndefined();
  });

  it("rejects a non-positive ttl", async () => {
    const identity = await freshIdentity();
    const user = await identity.createUser({
      email: "t@example.com",
      name: "T",
    });
    await expect(
      identity.createSession(user.id, { ttlMs: 0 }),
    ).rejects.toMatchObject({ code: "identity/invalid-ttl" });
    await expect(
      identity.createInvitation({ data: null, ttlMs: -1 }),
    ).rejects.toMatchObject({ code: "identity/invalid-ttl" });
  });

  it("rejects an invalid email or an empty name", async () => {
    const identity = await freshIdentity();
    await expect(
      identity.createUser({ email: "not-an-email", name: "N" }),
    ).rejects.toMatchObject({ code: "identity/invalid-email" });
    await expect(
      identity.createUser({ email: "n@example.com", name: "  " }),
    ).rejects.toMatchObject({ code: "identity/invalid-name" });
  });

  it("upgrades a database from the first schema, keeping users and dropping old sessions", async () => {
    const root = new Context();
    let storage!: StorageService;
    const storageLocation = await testStorageLocation();
    const storageFiber = await root.plugin((ctx: Context) => {
      storage = createStorageService(ctx, storageLocation);
      ctx.provide("storage", storage);
    });
    fibers.push(storageFiber);
    const [first] = identityMigrations;
    if (!first) throw new Error("expected a first migration");
    await storage.migrate("@docleus/core-identity", [first]);
    const db = storage.db as Kysely<unknown>;
    await sql`insert into users (id, email, name) values ('u1', 'Old@Example.com', 'Old'), ('u2', 'dup@example.com', 'Dup'), ('u3', 'DUP@example.com', 'Dup2')`.execute(
      db,
    );
    await sql`insert into sessions (token, user_id, created_at) values ('plain', 'u1', 0)`.execute(
      db,
    );

    let identity!: IdentityService;
    await root.plugin({
      inject: ["storage"],
      apply: (ctx: Context) => {
        identity = createIdentityService(ctx);
      },
    });

    expect(await identity.getUser("u1")).toEqual({
      id: "u1",
      email: "old@example.com",
      name: "Old",
      hasPassword: false,
    });
    expect((await identity.getUser("u3"))?.email).toBe("DUP@example.com");
    expect(await identity.authenticate("plain")).toBeUndefined();
    const token = await identity.createSession("u1");
    expect((await identity.authenticate(token))?.id).toBe("u1");
  });
});
