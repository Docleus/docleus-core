import type { AuthzService, Scope } from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

const user = (id: string) => ({ kind: "user" as const, userId: id });
const org = (id: string) => ({ kind: "org" as const, orgId: id });
const space = (orgId: string, id: string) => ({
  kind: "space" as const,
  orgId,
  spaceId: id,
});
const instance = { kind: "instance" as const };

const sortGrants = <T extends { userId: string }>(grants: T[]): T[] =>
  grants.toSorted((a, b) => a.userId.localeCompare(b.userId));

export const authzConformanceSuite = defineConformanceSuite<AuthzService>(
  "authz",
  [
    {
      name: "a user with no grant is denied everywhere",
      async check(authz) {
        expect(await authz.can(user("u1"), "read", instance)).toBe(false);
        expect(await authz.can(user("u1"), "read", org("o1"))).toBe(false);
        expect(await authz.can(user("u1"), "read", space("o1", "s1"))).toBe(
          false,
        );
      },
    },
    {
      name: "an anonymous actor is always denied, even at an instance grant",
      async check(authz) {
        await authz.grant("u1", instance, "admin");
        expect(await authz.can({ kind: "anonymous" }, "read", instance)).toBe(
          false,
        );
      },
    },
    {
      name: "instance admin allows every action everywhere",
      async check(authz) {
        await authz.grant("u1", instance, "admin");
        for (const scope of [instance, org("o1"), space("o1", "s1")]) {
          for (const action of ["read", "write", "manage"] as const) {
            expect(await authz.can(user("u1"), action, scope)).toBe(true);
          }
        }
      },
    },
    {
      name: "org owner and admin allow every action on the org and its spaces, and nothing elsewhere",
      async check(authz) {
        await authz.grant("u1", org("o1"), "owner");
        await authz.grant("u2", org("o1"), "admin");
        for (const id of ["u1", "u2"]) {
          for (const action of ["read", "write", "manage"] as const) {
            expect(await authz.can(user(id), action, org("o1"))).toBe(true);
            expect(await authz.can(user(id), action, space("o1", "s1"))).toBe(
              true,
            );
          }
          expect(await authz.can(user(id), "read", org("o2"))).toBe(false);
          expect(await authz.can(user(id), "read", space("o2", "s1"))).toBe(
            false,
          );
          expect(await authz.can(user(id), "read", instance)).toBe(false);
        }
      },
    },
    {
      name: "org member reads the org and its spaces but cannot write or manage",
      async check(authz) {
        await authz.grant("u1", org("o1"), "member");
        expect(await authz.can(user("u1"), "read", org("o1"))).toBe(true);
        expect(await authz.can(user("u1"), "read", space("o1", "s1"))).toBe(
          true,
        );
        expect(await authz.can(user("u1"), "write", space("o1", "s1"))).toBe(
          false,
        );
        expect(await authz.can(user("u1"), "write", org("o1"))).toBe(false);
        expect(await authz.can(user("u1"), "manage", org("o1"))).toBe(false);
      },
    },
    {
      name: "space roles allow their own actions on that space only",
      async check(authz) {
        await authz.grant("admin", space("o1", "s1"), "admin");
        await authz.grant("editor", space("o1", "s1"), "editor");
        await authz.grant("viewer", space("o1", "s1"), "viewer");
        const s1 = space("o1", "s1");
        const expected = {
          admin: [true, true, true],
          editor: [true, true, false],
          viewer: [true, false, false],
        };
        for (const [id, allowed] of Object.entries(expected)) {
          expect([
            await authz.can(user(id), "read", s1),
            await authz.can(user(id), "write", s1),
            await authz.can(user(id), "manage", s1),
          ]).toEqual(allowed);
          expect(await authz.can(user(id), "read", space("o1", "s2"))).toBe(
            false,
          );
        }
      },
    },
    {
      name: "a space grant allows reading its org and nothing more there",
      async check(authz) {
        await authz.grant("u1", space("o1", "s1"), "admin");
        expect(await authz.can(user("u1"), "read", org("o1"))).toBe(true);
        expect(await authz.can(user("u1"), "write", org("o1"))).toBe(false);
        expect(await authz.can(user("u1"), "manage", org("o1"))).toBe(false);
        expect(await authz.can(user("u1"), "read", org("o2"))).toBe(false);
      },
    },
    {
      name: "a grant with a role the scope does not take is rejected",
      async check(authz) {
        const cases: [Scope, string][] = [
          [instance, "viewer"],
          [instance, "owner"],
          [org("o1"), "editor"],
          [org("o1"), "viewer"],
          [space("o1", "s1"), "owner"],
          [space("o1", "s1"), "member"],
          [org("o1"), "superuser"],
        ];
        for (const [scope, role] of cases) {
          await expect(
            authz.grant("u1", scope, role as never),
          ).rejects.toMatchObject({ code: "authz/invalid-role" });
          expect(await authz.roleAt("u1", scope)).toBeUndefined();
        }
      },
    },
    {
      name: "revoke removes the grant, denying access again",
      async check(authz) {
        await authz.grant("u1", org("o1"), "admin");
        await authz.revoke("u1", org("o1"));
        expect(await authz.can(user("u1"), "read", org("o1"))).toBe(false);
      },
    },
    {
      name: "granting again at the same scope replaces the previous role",
      async check(authz) {
        await authz.grant("u1", org("o1"), "admin");
        await authz.grant("u1", org("o1"), "member");
        expect(await authz.can(user("u1"), "write", org("o1"))).toBe(false);
        expect(await authz.can(user("u1"), "read", org("o1"))).toBe(true);
        expect(await authz.roleAt("u1", org("o1"))).toBe("member");
      },
    },
    {
      name: "roleAt returns the exact grant at that scope, not an inherited one",
      async check(authz) {
        await authz.grant("u1", instance, "admin");
        await authz.grant("u1", org("o1"), "owner");
        expect(await authz.roleAt("u1", org("o2"))).toBeUndefined();
        expect(await authz.roleAt("u1", space("o1", "s1"))).toBeUndefined();
        expect(await authz.roleAt("u1", org("o1"))).toBe("owner");
        expect(await authz.roleAt("u1", instance)).toBe("admin");
      },
    },
    {
      name: "a higher role at a broader scope is used when it allows more than a narrower one",
      async check(authz) {
        await authz.grant("u1", space("o1", "s1"), "viewer");
        await authz.grant("u1", org("o1"), "admin");
        expect(await authz.can(user("u1"), "manage", space("o1", "s1"))).toBe(
          true,
        );
      },
    },
    {
      name: "a higher role at a narrower scope is used when it allows more than a broader one",
      async check(authz) {
        await authz.grant("u1", org("o1"), "member");
        await authz.grant("u1", space("o1", "s1"), "editor");
        expect(await authz.can(user("u1"), "write", space("o1", "s1"))).toBe(
          true,
        );
        expect(await authz.can(user("u1"), "write", space("o1", "s2"))).toBe(
          false,
        );
      },
    },
    {
      name: "listGrants returns the grants made at exactly that scope",
      async check(authz) {
        await authz.grant("u1", org("o1"), "owner");
        await authz.grant("u2", org("o1"), "member");
        await authz.grant("u3", space("o1", "s1"), "viewer");
        await authz.grant("u4", org("o2"), "admin");
        await authz.grant("u5", instance, "admin");
        expect(sortGrants(await authz.listGrants(org("o1")))).toEqual([
          { userId: "u1", scope: org("o1"), role: "owner" },
          { userId: "u2", scope: org("o1"), role: "member" },
        ]);
        expect(await authz.listGrants(space("o1", "s1"))).toEqual([
          { userId: "u3", scope: space("o1", "s1"), role: "viewer" },
        ]);
        expect(await authz.listGrants(space("o1", "s2"))).toEqual([]);
      },
    },
    {
      name: "listUserGrants returns every grant of the user at any scope",
      async check(authz) {
        await authz.grant("u1", instance, "admin");
        await authz.grant("u1", org("o1"), "member");
        await authz.grant("u1", space("o2", "s1"), "editor");
        await authz.grant("u2", org("o1"), "owner");
        const grants = await authz.listUserGrants("u1");
        expect(grants).toHaveLength(3);
        expect(grants).toEqual(
          expect.arrayContaining([
            { userId: "u1", scope: instance, role: "admin" },
            { userId: "u1", scope: org("o1"), role: "member" },
            { userId: "u1", scope: space("o2", "s1"), role: "editor" },
          ]),
        );
        expect(await authz.listUserGrants("nobody")).toEqual([]);
      },
    },
    {
      name: "revokeAll on an org removes the org's and its spaces' grants only",
      async check(authz) {
        await authz.grant("u1", org("o1"), "owner");
        await authz.grant("u2", space("o1", "s1"), "editor");
        await authz.grant("u3", org("o2"), "member");
        await authz.grant("u4", space("o2", "s1"), "viewer");
        await authz.grant("u5", space("o10", "s1"), "viewer");
        await authz.grant("u6", instance, "admin");
        await authz.revokeAll(org("o1"));
        expect(await authz.listGrants(org("o1"))).toEqual([]);
        expect(await authz.listGrants(space("o1", "s1"))).toEqual([]);
        expect(await authz.can(user("u2"), "read", org("o1"))).toBe(false);
        expect(await authz.roleAt("u3", org("o2"))).toBe("member");
        expect(await authz.roleAt("u4", space("o2", "s1"))).toBe("viewer");
        expect(await authz.roleAt("u5", space("o10", "s1"))).toBe("viewer");
        expect(await authz.roleAt("u6", instance)).toBe("admin");
      },
    },
    {
      name: "revokeAll on a space removes that space's grants only",
      async check(authz) {
        await authz.grant("u1", space("o1", "s1"), "editor");
        await authz.grant("u2", space("o1", "s2"), "editor");
        await authz.grant("u3", org("o1"), "member");
        await authz.revokeAll(space("o1", "s1"));
        expect(await authz.listGrants(space("o1", "s1"))).toEqual([]);
        expect(await authz.roleAt("u2", space("o1", "s2"))).toBe("editor");
        expect(await authz.roleAt("u3", org("o1"))).toBe("member");
      },
    },
    {
      name: "canEach answers like can for each resource, in the order given",
      async check(authz) {
        await authz.grant("u1", org("o1"), "member");
        await authz.grant("u1", space("o2", "s1"), "editor");
        const resources: Scope[] = [
          org("o2"),
          space("o1", "s1"),
          instance,
          org("o3"),
          space("o2", "s1"),
          org("o1"),
          space("o2", "s2"),
        ];
        for (const action of ["read", "write", "manage"] as const) {
          const expected: boolean[] = [];
          for (const resource of resources) {
            expected.push(await authz.can(user("u1"), action, resource));
          }
          expect(await authz.canEach(user("u1"), action, resources)).toEqual(
            expected,
          );
        }
        expect(await authz.canEach(user("u1"), "read", [])).toEqual([]);
        expect(
          await authz.canEach({ kind: "anonymous" }, "read", resources),
        ).toEqual(resources.map(() => false));
      },
    },
    {
      name: "a scope with an invalid id is rejected",
      async check(authz) {
        await expectToReject(() => authz.grant("u1", org("bad id!"), "member"));
        await expectToReject(() => authz.listGrants(space("o1", "../s1")));
      },
    },
  ],
);
