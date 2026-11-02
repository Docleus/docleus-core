import { DocleusError, type Context } from "@docleus/kernel";
import {
  scopeKey,
  type Action,
  type Actor,
  type AuthzService,
  type Grant,
  type Role,
  type RoleAt,
  type Scope,
} from "@docleus/sdk";
import type { Kysely } from "kysely";
import { isRoleAt, roleAllows } from "./roles.ts";
import { orgSpaceKeyRange, parseScopeKey, scopeChain } from "./scope-chain.ts";
import { authzMigrations, type AuthzSchema } from "./schema.ts";

function parseRole<S extends Scope>(scope: S, value: string): RoleAt<S> {
  if (!isRoleAt(scope.kind, value)) {
    throw new DocleusError(
      "authz/invalid-role",
      `stored role "${value}" is not a role of the ${scope.kind} scope`,
    );
  }
  return value as RoleAt<S>;
}

/**
 * Whether the stored `roles` (scope key to role, all of one user) allow
 * `action` on `resource`. Only the rows that bear on `resource` are parsed,
 * so one malformed grant elsewhere does not deny everything.
 */
function allows(
  roles: ReadonlyMap<string, string>,
  action: Action,
  resource: Scope,
): boolean {
  for (const scope of scopeChain(resource)) {
    const stored = roles.get(scopeKey(scope));
    if (stored === undefined) continue;
    const role: Role = parseRole(scope, stored);
    if (roleAllows(scope.kind, role, action)) return true;
  }
  if (resource.kind !== "org" || action !== "read") return false;
  const { from } = orgSpaceKeyRange(resource.orgId);
  let hasSpaceGrant = false;
  for (const [key, stored] of roles) {
    if (!key.startsWith(from)) continue;
    parseRole(parseScopeKey(key), stored);
    hasSpaceGrant = true;
  }
  return hasSpaceGrant;
}

function toGrant<S extends Scope>(
  userId: string,
  scope: S,
  role: string,
): Grant<S> {
  return { userId, scope, role: parseRole(scope, role) };
}

/**
 * Default `authz` implementation: role grants stored at instance, org and
 * space level, with the per-scope roles and inheritance described on
 * `AuthzService`. Reads `identity` to deny users that no longer exist.
 *
 * @stability experimental
 */
export function createAuthzService(ctx: Context): AuthzService {
  const db = ctx.storage.db as unknown as Kysely<AuthzSchema>;
  const ready = ctx.storage.migrate("@docleus/core-authz", authzMigrations);

  async function userExists(userId: string): Promise<boolean> {
    return (await ctx.identity.getUser(userId)) !== undefined;
  }

  async function canEach(
    actor: Actor,
    action: Action,
    resources: readonly Scope[],
  ): Promise<boolean[]> {
    if (actor.kind === "anonymous" || resources.length === 0) {
      return resources.map(() => false);
    }
    await ready;
    const rows = await db
      .selectFrom("authz_grants")
      .select(["scope_key", "role"])
      .where("user_id", "=", actor.userId)
      .execute();
    const roles = new Map(rows.map((row) => [row.scope_key, row.role]));
    const results = resources.map((resource) =>
      allows(roles, action, resource),
    );
    // Grants outlive their user, and an actor may come from a token that
    // was issued before the user was removed.
    if (results.includes(true) && !(await userExists(actor.userId))) {
      return resources.map(() => false);
    }
    return results;
  }

  return {
    async grant(userId, scope, role) {
      const key = scopeKey(scope);
      if (!isRoleAt(scope.kind, role)) {
        throw new DocleusError(
          "authz/invalid-role",
          `"${String(role)}" is not a role of the ${scope.kind} scope`,
        );
      }
      await ready;
      await db
        .insertInto("authz_grants")
        .values({ user_id: userId, scope_key: key, role })
        .onConflict((oc) =>
          oc.columns(["user_id", "scope_key"]).doUpdateSet({ role }),
        )
        .execute();
    },
    async revoke(userId, scope) {
      const key = scopeKey(scope);
      await ready;
      await db
        .deleteFrom("authz_grants")
        .where("user_id", "=", userId)
        .where("scope_key", "=", key)
        .execute();
    },
    async roleAt(userId, scope) {
      const key = scopeKey(scope);
      await ready;
      const row = await db
        .selectFrom("authz_grants")
        .select("role")
        .where("user_id", "=", userId)
        .where("scope_key", "=", key)
        .executeTakeFirst();
      return row && parseRole(scope, row.role);
    },
    async listGrants(scope) {
      const key = scopeKey(scope);
      await ready;
      const rows = await db
        .selectFrom("authz_grants")
        .select(["user_id", "role"])
        .where("scope_key", "=", key)
        .execute();
      return rows.map((row) => toGrant(row.user_id, scope, row.role));
    },
    async listUserGrants(userId) {
      await ready;
      const rows = await db
        .selectFrom("authz_grants")
        .select(["scope_key", "role"])
        .where("user_id", "=", userId)
        .orderBy("scope_key")
        .execute();
      return rows.map((row): Grant =>
        toGrant(userId, parseScopeKey(row.scope_key), row.role),
      );
    },
    async revokeAll(scope) {
      const key = scopeKey(scope);
      await ready;
      if (scope.kind === "instance") {
        await db.deleteFrom("authz_grants").execute();
        return;
      }
      if (scope.kind === "space") {
        await db
          .deleteFrom("authz_grants")
          .where("scope_key", "=", key)
          .execute();
        return;
      }
      const { from, to } = orgSpaceKeyRange(scope.orgId);
      await db
        .deleteFrom("authz_grants")
        .where((eb) =>
          eb.or([
            eb("scope_key", "=", key),
            eb.and([eb("scope_key", ">=", from), eb("scope_key", "<", to)]),
          ]),
        )
        .execute();
    },
    async can(actor, action, resource) {
      const [isAllowed] = await canEach(actor, action, [resource]);
      return isAllowed === true;
    },
    canEach,
  };
}

export function provideAuthz(ctx: Context): () => void {
  return ctx.provide("authz", createAuthzService(ctx));
}

export type { Action, Role, Scope };
export { DocleusError };
