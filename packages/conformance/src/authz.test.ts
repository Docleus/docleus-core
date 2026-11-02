import {
  scopeKey,
  type Action,
  type AuthzService,
  type Grant,
  type Scope,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { authzConformanceSuite } from "./authz.ts";
import { checkInvariant, runConformanceSuite } from "./suite.ts";

type Bug =
  | "allow-everything"
  | "can-each-unordered"
  | "member-writes"
  | "no-role-validation"
  | "no-space-to-org-read"
  | "revoke-all-not-cascading";

const ALL: readonly Action[] = ["read", "write", "manage"];
const ACTIONS: Record<Scope["kind"], Record<string, readonly Action[]>> = {
  instance: { admin: ALL },
  org: { owner: ALL, admin: ALL, member: ["read"] },
  space: { admin: ALL, editor: ["read", "write"], viewer: ["read"] },
};

function chain(scope: Scope): Scope[] {
  if (scope.kind === "instance") return [scope];
  if (scope.kind === "org") return [scope, { kind: "instance" }];
  return [scope, { kind: "org", orgId: scope.orgId }, { kind: "instance" }];
}

function key(userId: string, scope: Scope): string {
  return `${userId}|${scopeKey(scope)}`;
}

function isBelow(scope: Scope, parent: Scope): boolean {
  return chain(scope).some(
    (candidate) => scopeKey(candidate) === scopeKey(parent),
  );
}

/** An in-memory implementation that passes the suite unless `bug` is set. */
function createInMemoryAuthz(bug?: Bug): AuthzService {
  const grants = new Map<string, Grant>();
  const allows = (grant: Grant, action: Action) =>
    bug === "member-writes" && grant.role === "member"
      ? true
      : (ACTIONS[grant.scope.kind][grant.role]?.includes(action) ?? false);
  const service: AuthzService = {
    async grant(userId, scope, role) {
      scopeKey(scope);
      if (
        bug !== "no-role-validation" &&
        !Object.hasOwn(ACTIONS[scope.kind], role)
      ) {
        throw Object.assign(new Error("invalid role"), {
          code: "authz/invalid-role",
        });
      }
      grants.set(key(userId, scope), { userId, scope, role } as Grant);
    },
    async revoke(userId, scope) {
      grants.delete(key(userId, scope));
    },
    async roleAt(userId, scope) {
      return grants.get(key(userId, scope))?.role as never;
    },
    async listGrants(scope) {
      const wanted = scopeKey(scope);
      return [...grants.values()].filter(
        (grant) => scopeKey(grant.scope) === wanted,
      ) as never;
    },
    async listUserGrants(userId) {
      return [...grants.values()].filter((grant) => grant.userId === userId);
    },
    async revokeAll(scope) {
      for (const [id, grant] of grants) {
        const matches =
          bug === "revoke-all-not-cascading"
            ? scopeKey(grant.scope) === scopeKey(scope)
            : isBelow(grant.scope, scope);
        if (matches) grants.delete(id);
      }
    },
    async can(actor, action, resource) {
      if (bug === "allow-everything") return true;
      if (actor.kind === "anonymous") return false;
      for (const scope of chain(resource)) {
        const grant = grants.get(key(actor.userId, scope));
        if (grant && allows(grant, action)) return true;
      }
      return (
        bug !== "no-space-to-org-read" &&
        resource.kind === "org" &&
        action === "read" &&
        [...grants.values()].some(
          (grant) =>
            grant.userId === actor.userId &&
            grant.scope.kind === "space" &&
            grant.scope.orgId === resource.orgId,
        )
      );
    },
    async canEach(actor, action, resources) {
      const results = await Promise.all(
        resources.map((resource) => service.can(actor, action, resource)),
      );
      return bug === "can-each-unordered" ? results.toSorted() : results;
    },
  };
  return service;
}

describe("the in-memory reference implementation", () => {
  runConformanceSuite(authzConformanceSuite, () => createInMemoryAuthz());
});

describe("deliberately broken authz implementations", () => {
  const cases: [Bug, string[]][] = [
    [
      "allow-everything",
      [
        "a user with no grant is denied everywhere",
        "an anonymous actor is always denied, even at an instance grant",
      ],
    ],
    [
      "can-each-unordered",
      ["canEach answers like can for each resource, in the order given"],
    ],
    [
      "member-writes",
      ["org member reads the org and its spaces but cannot write or manage"],
    ],
    [
      "no-role-validation",
      ["a grant with a role the scope does not take is rejected"],
    ],
    [
      "no-space-to-org-read",
      ["a space grant allows reading its org and nothing more there"],
    ],
    [
      "revoke-all-not-cascading",
      ["revokeAll on an org removes the org's and its spaces' grants only"],
    ],
  ];
  for (const [bug, names] of cases) {
    it(`rejects "${bug}"`, async () => {
      for (const name of names) {
        const invariant = authzConformanceSuite.invariants.find(
          (candidate) => candidate.name === name,
        );
        if (!invariant) throw new Error(`expected invariant "${name}"`);
        await expect(
          checkInvariant(invariant, () => createInMemoryAuthz(bug)),
        ).rejects.toThrow();
      }
    });
  }
});
