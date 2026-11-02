import { createHash, randomBytes } from "node:crypto";
import { DocleusError, type Context } from "@docleus/kernel";
import {
  DEFAULT_SESSION_TTL_MS,
  trackCaller,
  type IdentityProvider,
  type IdentityService,
  type Invitation,
  type ProviderInfo,
  type User,
} from "@docleus/sdk";
import { hash, verify } from "@node-rs/argon2";
import type { Kysely, Selectable } from "kysely";
import { v7 as uuidv7 } from "uuid";
import {
  identityMigrations,
  type IdentitySchema,
  type InvitationsTable,
  type UsersTable,
} from "./schema.ts";

/** Seven days. */
export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

// Verified against when the email is unknown, so that a failed sign-in takes
// as long either way. Same parameters as the hashes `hash()` produces.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$VaSmqi9Tc3DkqjtNnzGqIA$EB416DBB4FZytueyi7D64PlSnkGlt0OYxCW23LBHoEk";

export interface IdentityServiceOptions {
  /** Clock for session and invitation expiry; defaults to `Date.now`. */
  readonly now?: () => number;
}

type Db = Kysely<IdentitySchema>;

const GET_USERS_BATCH = 500;

function toUser(row: Selectable<UsersTable>): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    hasPassword: row.password_hash !== null,
  };
}

function toInvitation(row: Selectable<InvitationsTable>): Invitation {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch (error) {
    throw new DocleusError(
      "identity/invalid-invitation-data",
      `invitation "${row.id}" has data that is not JSON`,
      { cause: error },
    );
  }
  return {
    id: row.id,
    email: row.email ?? undefined,
    data,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    throw new DocleusError(
      "identity/invalid-email",
      `invalid email "${email}"`,
    );
  }
  return normalized;
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (normalized === "") {
    throw new DocleusError("identity/invalid-name", "name must not be empty");
  }
  return normalized;
}

function assertPassword(password: string): void {
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new DocleusError(
      "identity/invalid-password",
      `password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters long`,
    );
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DocleusError("identity/invalid-ttl", `invalid ttl ${ttlMs}`);
  }
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function userNotFound(id: string): DocleusError {
  return new DocleusError("identity/user-not-found", `no user "${id}"`);
}

/**
 * Default `identity` implementation on top of `ctx.storage`: users with
 * argon2id passwords, hashed session and invitation tokens with an expiry,
 * links from provider identities to users, and a registry of identity
 * providers.
 *
 * @stability experimental
 */
export function createIdentityService(
  ctx: Context,
  options: IdentityServiceOptions = {},
): IdentityService {
  const db = ctx.storage.db as unknown as Db;
  const now = options.now ?? (() => Date.now());
  const providers = new Map<string, IdentityProvider>();
  // `storage`'s own disposal effect awaits this before closing the
  // connection, so a fiber that unloads without ever using the identity
  // service does not race it against the connection teardown.
  const ready = ctx.storage.migrate(
    "@docleus/core-identity",
    identityMigrations,
  );

  function transaction<T>(fn: (trx: Db) => Promise<T>): Promise<T> {
    return ctx.storage.transaction((trx) => fn(trx as unknown as Db));
  }

  async function linkedUser(
    trx: Db,
    provider: string,
    subject: string,
  ): Promise<User | undefined> {
    const row = await trx
      .selectFrom("identities")
      .innerJoin("users", "users.id", "identities.user_id")
      .selectAll("users")
      .where("identities.provider", "=", provider)
      .where("identities.subject", "=", subject)
      .executeTakeFirst();
    return row && toUser(row);
  }

  async function userByEmail(
    trx: Db,
    email: string,
  ): Promise<User | undefined> {
    const row = await trx
      .selectFrom("users")
      .selectAll()
      .where("email", "=", email)
      .executeTakeFirst();
    return row && toUser(row);
  }

  async function createSession(userId: string, ttlMs = DEFAULT_SESSION_TTL_MS) {
    assertTtl(ttlMs);
    await ready;
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user) throw userNotFound(userId);
    const token = newToken();
    const createdAt = now();
    await db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .where("expires_at", "<=", createdAt)
      .execute();
    await db
      .insertInto("sessions")
      .values({
        token_hash: hashToken(token),
        user_id: userId,
        created_at: createdAt,
        expires_at: createdAt + ttlMs,
      })
      .execute();
    return token;
  }

  async function resolveExternal(
    providerId: string,
    identity: {
      subject?: string;
      email: string;
      name: string;
      isEmailVerified?: boolean;
    },
    allowSignup: boolean,
  ): Promise<User | undefined> {
    const email = normalizeEmail(identity.email);
    const subject = identity.subject ?? email;
    const name = identity.name.trim() || email;
    await ready;
    return transaction(async (trx) => {
      const linked = await linkedUser(trx, providerId, subject);
      if (linked) return linked;
      let user = await userByEmail(trx, email);
      if (!user && allowSignup) {
        const created = await trx
          .insertInto("users")
          .values({ id: uuidv7(), email, name, password_hash: null })
          .onConflict((oc) => oc.column("email").doNothing())
          .returningAll()
          .executeTakeFirst();
        if (created) user = toUser(created);
        else {
          // Lost a race against a concurrent first sign-in that does not
          // run serialized with this one; it may have linked already.
          const raced = await linkedUser(trx, providerId, subject);
          if (raced) return raced;
          user = await userByEmail(trx, email);
          if (!identity.isEmailVerified) return undefined;
        }
      } else if (!user || !identity.isEmailVerified) {
        return undefined;
      }
      if (!user) return undefined;
      await trx
        .insertInto("identities")
        .values({ provider: providerId, subject, user_id: user.id })
        .onConflict((oc) => oc.columns(["provider", "subject"]).doNothing())
        .execute();
      return linkedUser(trx, providerId, subject);
    });
  }

  async function activeInvitation(tokenHash: string, at: number, trx: Db = db) {
    return trx
      .selectFrom("invitations")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .where("used_at", "is", null)
      .where("expires_at", ">", at)
      .executeTakeFirst();
  }

  return trackCaller<IdentityService>(ctx, {
    registerProvider(id, provider) {
      return this.ctx.effect(
        () => {
          if (providers.has(id)) {
            throw new DocleusError(
              "identity/provider-already-registered",
              `provider "${id}" is already registered`,
            );
          }
          providers.set(id, provider);
          return () => providers.delete(id);
        },
        `ctx.identity.registerProvider(${JSON.stringify(id)})`,
      );
    },
    providers() {
      const listed: ProviderInfo[] = [];
      for (const [id, provider] of providers) {
        if (provider.display) listed.push({ id, display: provider.display });
      }
      return listed;
    },
    async login(providerId, credentials, loginOptions = {}) {
      const provider = providers.get(providerId);
      if (!provider) return undefined;
      const identity = await provider.authenticate(credentials);
      if (!identity) return undefined;
      const user = await resolveExternal(
        providerId,
        identity,
        loginOptions.allowSignup ?? false,
      );
      if (!user) return undefined;
      const token = await createSession(user.id, loginOptions.session?.ttlMs);
      return { token, user };
    },
    resolveExternal(providerId, identity, resolveOptions = {}) {
      return resolveExternal(
        providerId,
        identity,
        resolveOptions.allowSignup ?? false,
      );
    },

    async createUser(input) {
      const email = normalizeEmail(input.email);
      const name = normalizeName(input.name);
      if (input.password !== undefined) assertPassword(input.password);
      const passwordHash =
        input.password === undefined ? null : await hash(input.password);
      await ready;
      const row = await db
        .insertInto("users")
        .values({ id: uuidv7(), email, name, password_hash: passwordHash })
        .onConflict((oc) => oc.column("email").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new DocleusError(
          "identity/email-taken",
          `a user with email "${email}" exists`,
        );
      }
      return toUser(row);
    },
    async getUser(id) {
      await ready;
      const row = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      return row && toUser(row);
    },
    async getUsers(ids) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      await ready;
      const users: User[] = [];
      // Bounded batches keep each statement under the databases' limits on
      // bound parameters.
      for (let start = 0; start < unique.length; start += GET_USERS_BATCH) {
        const rows = await db
          .selectFrom("users")
          .selectAll()
          .where("id", "in", unique.slice(start, start + GET_USERS_BATCH))
          .execute();
        users.push(...rows.map(toUser));
      }
      return users;
    },
    async findUserByEmail(email) {
      await ready;
      return userByEmail(db, email.trim().toLowerCase());
    },
    async listUsers() {
      await ready;
      const rows = await db
        .selectFrom("users")
        .selectAll()
        .orderBy("email")
        .execute();
      return rows.map(toUser);
    },
    async countUsers() {
      await ready;
      const row = await db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    async updateUser(id, patch) {
      await ready;
      const row =
        patch.name === undefined
          ? await db
              .selectFrom("users")
              .selectAll()
              .where("id", "=", id)
              .executeTakeFirst()
          : await db
              .updateTable("users")
              .set({ name: normalizeName(patch.name) })
              .where("id", "=", id)
              .returningAll()
              .executeTakeFirst();
      if (!row) throw userNotFound(id);
      return toUser(row);
    },
    async setPassword(userId, password) {
      if (password !== undefined) assertPassword(password);
      const passwordHash = password === undefined ? null : await hash(password);
      await ready;
      const row = await db
        .updateTable("users")
        .set({ password_hash: passwordHash })
        .where("id", "=", userId)
        .returning("id")
        .executeTakeFirst();
      if (!row) throw userNotFound(userId);
    },
    async verifyPassword(email, password) {
      if (password.length > MAX_PASSWORD_LENGTH) return undefined;
      await ready;
      const row = await db
        .selectFrom("users")
        .selectAll()
        .where("email", "=", email.trim().toLowerCase())
        .executeTakeFirst();
      const stored = row?.password_hash ?? null;
      const isMatch = await verify(stored ?? DUMMY_PASSWORD_HASH, password);
      return row && stored !== null && isMatch ? toUser(row) : undefined;
    },

    createSession(userId, sessionOptions = {}) {
      return createSession(userId, sessionOptions.ttlMs);
    },
    async authenticate(token) {
      await ready;
      const tokenHash = hashToken(token);
      const row = await db
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .selectAll("users")
        .select("sessions.expires_at")
        .where("sessions.token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (!row) return undefined;
      if (row.expires_at <= now()) {
        await db
          .deleteFrom("sessions")
          .where("token_hash", "=", tokenHash)
          .execute();
        return undefined;
      }
      return toUser(row);
    },
    async logout(token) {
      await ready;
      await db
        .deleteFrom("sessions")
        .where("token_hash", "=", hashToken(token))
        .execute();
    },
    async logoutAll(userId) {
      await ready;
      await db.deleteFrom("sessions").where("user_id", "=", userId).execute();
    },

    async createInvitation(input) {
      const email =
        input.email === undefined ? null : normalizeEmail(input.email);
      const ttlMs = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
      assertTtl(ttlMs);
      let data: string;
      try {
        data = JSON.stringify(input.data) ?? "null";
      } catch (error) {
        throw new DocleusError(
          "identity/invalid-invitation-data",
          "invitation data must be JSON-serializable",
          { cause: error },
        );
      }
      const token = newToken();
      const createdAt = now();
      await ready;
      const row = await db
        .insertInto("invitations")
        .values({
          id: uuidv7(),
          token_hash: hashToken(token),
          email,
          data,
          created_by: input.createdBy ?? null,
          created_at: createdAt,
          expires_at: createdAt + ttlMs,
          used_at: null,
          used_by: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { invitation: toInvitation(row), token };
    },
    async findInvitation(token) {
      await ready;
      const row = await activeInvitation(hashToken(token), now());
      return row && toInvitation(row);
    },
    async listInvitations() {
      await ready;
      const rows = await db
        .selectFrom("invitations")
        .selectAll()
        .where("used_at", "is", null)
        .where("expires_at", ">", now())
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(toInvitation);
    },
    async consumeInvitation(token, userId) {
      const tokenHash = hashToken(token);
      await ready;
      return transaction(async (trx) => {
        const at = now();
        const notFound = new DocleusError(
          "identity/invitation-not-found",
          "the invitation does not exist, was used or has expired",
        );
        const row = await activeInvitation(tokenHash, at, trx);
        if (!row) throw notFound;
        const user = await trx
          .selectFrom("users")
          .select("email")
          .where("id", "=", userId)
          .executeTakeFirst();
        if (!user) throw userNotFound(userId);
        if (row.email !== null && row.email !== user.email) {
          throw new DocleusError(
            "identity/invitation-email-mismatch",
            "the invitation is for another email",
          );
        }
        const used = await trx
          .updateTable("invitations")
          .set({ used_at: at, used_by: userId })
          .where("id", "=", row.id)
          .where("used_at", "is", null)
          .returning("id")
          .executeTakeFirst();
        if (!used) throw notFound;
        return toInvitation(row);
      });
    },
    async revokeInvitation(id) {
      await ready;
      await db.deleteFrom("invitations").where("id", "=", id).execute();
    },
  });
}

export function provideIdentity(
  ctx: Context,
  options?: IdentityServiceOptions,
): () => void {
  return ctx.provide("identity", createIdentityService(ctx, options));
}
