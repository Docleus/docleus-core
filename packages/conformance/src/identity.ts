import {
  DEFAULT_SESSION_TTL_MS,
  type ExternalIdentity,
  type IdentityService,
} from "@docleus/sdk";
import { expect, vi } from "vitest";
import { defineConformanceSuite } from "./suite.ts";

const PROVIDER = "test-provider";
const PASSWORD = "correct horse battery";
const DAY = 24 * 60 * 60 * 1000;

function provide(
  identity: IdentityService,
  external: ExternalIdentity | undefined,
  id = PROVIDER,
): void {
  identity.registerProvider(id, { authenticate: async () => external });
}

/** Runs `fn` with a fake `Date` starting at `start`; timers stay real. */
async function withFakeDate(
  fn: (advance: (ms: number) => void) => Promise<void>,
  start = Date.UTC(2030, 0, 1),
): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"], now: start });
  try {
    await fn((ms) => vi.setSystemTime(Date.now() + ms));
  } finally {
    vi.useRealTimers();
  }
}

export const identityConformanceSuite = defineConformanceSuite<IdentityService>(
  "identity",
  [
    {
      name: "login through an unregistered provider returns undefined",
      async check(identity) {
        expect(
          await identity.login("no-such-provider", {}, { allowSignup: true }),
        ).toBeUndefined();
      },
    },
    {
      name: "login with credentials the provider rejects returns undefined",
      async check(identity) {
        provide(identity, undefined);
        expect(
          await identity.login(PROVIDER, { bad: true }, { allowSignup: true }),
        ).toBeUndefined();
      },
    },
    {
      name: "a successful login returns a token that authenticates to the returned user",
      async check(identity) {
        provide(identity, { email: "A@Example.com", name: "A" });
        const result = await identity.login(
          PROVIDER,
          {},
          { allowSignup: true },
        );
        if (!result) throw new Error("expected a login");
        expect(result.user.email).toBe("a@example.com");
        expect(await identity.authenticate(result.token)).toEqual(result.user);
      },
    },
    {
      name: "login without allowSignup does not create a user",
      async check(identity) {
        provide(identity, { email: "new@example.com", name: "New" });
        expect(await identity.login(PROVIDER, {})).toBeUndefined();
        expect(
          await identity.findUserByEmail("new@example.com"),
        ).toBeUndefined();
        expect(await identity.countUsers()).toBe(0);
      },
    },
    {
      name: "logging in twice with the same external identity reuses the same user",
      async check(identity) {
        provide(identity, { email: "same@example.com", name: "Same" });
        const first = await identity.login(PROVIDER, {}, { allowSignup: true });
        const second = await identity.login(PROVIDER, {});
        expect(first?.user.id).toBeDefined();
        expect(second?.user.id).toBe(first?.user.id);
        expect(first?.token).not.toBe(second?.token);
      },
    },
    {
      name: "providers lists the providers that have a display, in registration order",
      check(identity) {
        identity.registerProvider("b", {
          display: { label: "B", href: "/b" },
          authenticate: async () => undefined,
        });
        identity.registerProvider("hidden", {
          authenticate: async () => undefined,
        });
        const disposeA = identity.registerProvider("a", {
          display: { label: "A", href: "/a" },
          authenticate: async () => undefined,
        });
        expect(identity.providers()).toEqual([
          { id: "b", display: { label: "B", href: "/b" } },
          { id: "a", display: { label: "A", href: "/a" } },
        ]);
        disposeA();
        expect(identity.providers().map((info) => info.id)).toEqual(["b"]);
      },
    },
    {
      name: "registering a provider under an id that is already registered throws",
      check(identity) {
        provide(identity, undefined, "dup");
        expect(() => provide(identity, undefined, "dup")).toThrow();
      },
    },
    {
      name: "resolveExternal creates a user only when signup is allowed",
      async check(identity) {
        const external = { subject: "s1", email: "x@example.com", name: "X" };
        expect(
          await identity.resolveExternal(PROVIDER, external),
        ).toBeUndefined();
        expect(
          await identity.resolveExternal(PROVIDER, external, {
            allowSignup: false,
          }),
        ).toBeUndefined();
        const created = await identity.resolveExternal(PROVIDER, external, {
          allowSignup: true,
        });
        expect(created).toMatchObject({
          email: "x@example.com",
          name: "X",
          hasPassword: false,
        });
        expect(await identity.resolveExternal(PROVIDER, external)).toEqual(
          created,
        );
      },
    },
    {
      name: "resolveExternal matches a linked identity by subject even when its email changed",
      async check(identity) {
        const created = await identity.resolveExternal(
          PROVIDER,
          { subject: "sub-1", email: "old@example.com", name: "O" },
          { allowSignup: true },
        );
        const again = await identity.resolveExternal(PROVIDER, {
          subject: "sub-1",
          email: "new@example.com",
          name: "O",
        });
        expect(again?.id).toBe(created?.id);
        const otherProvider = await identity.resolveExternal("other", {
          subject: "sub-1",
          email: "unrelated@example.com",
          name: "U",
        });
        expect(otherProvider).toBeUndefined();
      },
    },
    {
      name: "an identity with a verified email is linked to the existing user with that email",
      async check(identity) {
        const existing = await identity.createUser({
          email: "Owner@Example.com",
          name: "Owner",
        });
        const linked = await identity.resolveExternal(PROVIDER, {
          subject: "sub-x",
          email: "owner@example.COM",
          name: "Someone",
          isEmailVerified: true,
        });
        expect(linked?.id).toBe(existing.id);
        const viaSubject = await identity.resolveExternal(PROVIDER, {
          subject: "sub-x",
          email: "changed@example.com",
          name: "Someone",
        });
        expect(viaSubject?.id).toBe(existing.id);
        expect(await identity.countUsers()).toBe(1);
      },
    },
    {
      name: "an identity with an unverified email is never linked to an existing user, even with signup allowed",
      async check(identity) {
        const existing = await identity.createUser({
          email: "victim@example.com",
          name: "Victim",
        });
        for (const isEmailVerified of [false, undefined]) {
          const resolved = await identity.resolveExternal(
            PROVIDER,
            {
              subject: "attacker",
              email: "victim@example.com",
              name: "Attacker",
              isEmailVerified,
            },
            { allowSignup: true },
          );
          expect(resolved).toBeUndefined();
        }
        expect(await identity.countUsers()).toBe(1);
        expect(await identity.getUser(existing.id)).toEqual(existing);
        provide(identity, {
          subject: "attacker",
          email: "victim@example.com",
          name: "Attacker",
        });
        expect(
          await identity.login(PROVIDER, {}, { allowSignup: true }),
        ).toBeUndefined();
      },
    },
    {
      name: "createUser lowercases the email and rejects a taken one",
      async check(identity) {
        const user = await identity.createUser({
          email: "Mixed@Example.com",
          name: "Mixed",
        });
        expect(user).toMatchObject({
          email: "mixed@example.com",
          name: "Mixed",
          hasPassword: false,
        });
        await expect(
          identity.createUser({ email: "MIXED@example.com", name: "Again" }),
        ).rejects.toMatchObject({ code: "identity/email-taken" });
        expect(await identity.findUserByEmail("mixed@EXAMPLE.com")).toEqual(
          user,
        );
        expect(await identity.getUser(user.id)).toEqual(user);
        expect(await identity.getUser("no-such-user")).toBeUndefined();
      },
    },
    {
      name: "getUsers returns the users that exist among the ids, once each",
      async check(identity) {
        expect(await identity.getUsers([])).toEqual([]);
        const a = await identity.createUser({
          email: "a@example.com",
          name: "A",
        });
        const b = await identity.createUser({
          email: "b@example.com",
          name: "B",
        });
        await identity.createUser({ email: "c@example.com", name: "C" });
        const found = await identity.getUsers([
          b.id,
          "no-such-user",
          a.id,
          b.id,
        ]);
        expect(found).toHaveLength(2);
        expect(found).toEqual(expect.arrayContaining([a, b]));
      },
    },
    {
      name: "listUsers and countUsers see every user",
      async check(identity) {
        expect(await identity.countUsers()).toBe(0);
        expect(await identity.listUsers()).toEqual([]);
        const b = await identity.createUser({
          email: "b@example.com",
          name: "B",
        });
        const a = await identity.createUser({
          email: "a@example.com",
          name: "A",
        });
        expect(await identity.countUsers()).toBe(2);
        const listed = await identity.listUsers();
        expect(listed).toHaveLength(2);
        expect(listed).toEqual(expect.arrayContaining([a, b]));
      },
    },
    {
      name: "updateUser changes the name and keeps everything else",
      async check(identity) {
        const user = await identity.createUser({
          email: "u@example.com",
          name: "Before",
          password: PASSWORD,
        });
        const updated = await identity.updateUser(user.id, { name: "After" });
        expect(updated).toEqual({ ...user, name: "After" });
        expect(await identity.getUser(user.id)).toEqual(updated);
        await expect(
          identity.updateUser("no-such-user", { name: "X" }),
        ).rejects.toThrow();
      },
    },
    {
      name: "verifyPassword accepts the right password only",
      async check(identity) {
        const user = await identity.createUser({
          email: "p@example.com",
          name: "P",
          password: PASSWORD,
        });
        expect(user.hasPassword).toBe(true);
        expect(
          await identity.verifyPassword("P@example.com", PASSWORD),
        ).toEqual(user);
        expect(
          await identity.verifyPassword("p@example.com", `${PASSWORD}!`),
        ).toBeUndefined();
        expect(
          await identity.verifyPassword("unknown@example.com", PASSWORD),
        ).toBeUndefined();
      },
    },
    {
      name: "a user without a password never verifies",
      async check(identity) {
        await identity.createUser({ email: "np@example.com", name: "NP" });
        expect(
          await identity.verifyPassword("np@example.com", PASSWORD),
        ).toBeUndefined();
        expect(
          await identity.verifyPassword("np@example.com", ""),
        ).toBeUndefined();
      },
    },
    {
      name: "setPassword replaces the password, and undefined removes it",
      async check(identity) {
        const user = await identity.createUser({
          email: "sp@example.com",
          name: "SP",
          password: PASSWORD,
        });
        await identity.setPassword(user.id, "another password");
        expect(
          await identity.verifyPassword("sp@example.com", PASSWORD),
        ).toBeUndefined();
        expect(
          (await identity.verifyPassword("sp@example.com", "another password"))
            ?.id,
        ).toBe(user.id);
        await identity.setPassword(user.id, undefined);
        expect((await identity.getUser(user.id))?.hasPassword).toBe(false);
        expect(
          await identity.verifyPassword("sp@example.com", "another password"),
        ).toBeUndefined();
      },
    },
    {
      name: "a password shorter than 8 or longer than 256 characters is rejected",
      async check(identity) {
        for (const password of ["1234567", "x".repeat(257)]) {
          await expect(
            identity.createUser({
              email: "short@example.com",
              name: "S",
              password,
            }),
          ).rejects.toMatchObject({ code: "identity/invalid-password" });
        }
        expect(await identity.countUsers()).toBe(0);
        const user = await identity.createUser({
          email: "edge@example.com",
          name: "E",
          password: "12345678",
        });
        await expect(
          identity.setPassword(user.id, "x".repeat(257)),
        ).rejects.toMatchObject({ code: "identity/invalid-password" });
        await identity.setPassword(user.id, "x".repeat(256));
        expect(
          (await identity.verifyPassword("edge@example.com", "x".repeat(256)))
            ?.id,
        ).toBe(user.id);
      },
    },
    {
      name: "authenticate with an unknown token returns undefined",
      async check(identity) {
        expect(await identity.authenticate("no-such-token")).toBeUndefined();
        expect(await identity.authenticate("")).toBeUndefined();
      },
    },
    {
      name: "createSession returns a new token per call that authenticates to the user",
      async check(identity) {
        const user = await identity.createUser({
          email: "s@example.com",
          name: "S",
        });
        const first = await identity.createSession(user.id);
        const second = await identity.createSession(user.id);
        expect(first).not.toBe(second);
        expect(await identity.authenticate(first)).toEqual(user);
        expect(await identity.authenticate(second)).toEqual(user);
      },
    },
    {
      name: "logout invalidates the token, and the token cannot be reused afterwards",
      async check(identity) {
        provide(identity, { email: "b@example.com", name: "B" });
        const result = await identity.login(
          PROVIDER,
          {},
          { allowSignup: true },
        );
        if (!result) throw new Error("expected a login");
        const other = await identity.createSession(result.user.id);
        await identity.logout(result.token);
        expect(await identity.authenticate(result.token)).toBeUndefined();
        expect(await identity.authenticate(result.token)).toBeUndefined();
        expect((await identity.authenticate(other))?.id).toBe(result.user.id);
      },
    },
    {
      name: "logoutAll ends every session of that user only",
      async check(identity) {
        const a = await identity.createUser({
          email: "a@example.com",
          name: "A",
        });
        const b = await identity.createUser({
          email: "b@example.com",
          name: "B",
        });
        const a1 = await identity.createSession(a.id);
        const a2 = await identity.createSession(a.id);
        const b1 = await identity.createSession(b.id);
        await identity.logoutAll(a.id);
        expect(await identity.authenticate(a1)).toBeUndefined();
        expect(await identity.authenticate(a2)).toBeUndefined();
        expect((await identity.authenticate(b1))?.id).toBe(b.id);
      },
    },
    {
      name: "a session expires after its lifetime, 30 days by default",
      async check(identity) {
        await withFakeDate(async (advance) => {
          const user = await identity.createUser({
            email: "exp@example.com",
            name: "E",
          });
          const fallback = await identity.createSession(user.id);
          const short = await identity.createSession(user.id, { ttlMs: 1000 });
          advance(999);
          expect((await identity.authenticate(short))?.id).toBe(user.id);
          advance(1);
          expect(await identity.authenticate(short)).toBeUndefined();
          advance(DEFAULT_SESSION_TTL_MS - 1000 - 1);
          expect((await identity.authenticate(fallback))?.id).toBe(user.id);
          advance(1);
          expect(await identity.authenticate(fallback)).toBeUndefined();
        });
      },
    },
    {
      name: "login honours the session lifetime option",
      async check(identity) {
        await withFakeDate(async (advance) => {
          provide(identity, { email: "lt@example.com", name: "L" });
          const result = await identity.login(
            PROVIDER,
            {},
            { allowSignup: true, session: { ttlMs: 60_000 } },
          );
          if (!result) throw new Error("expected a login");
          advance(60_000);
          expect(await identity.authenticate(result.token)).toBeUndefined();
        });
      },
    },
    {
      name: "an invitation is found by its token and carries its data",
      async check(identity) {
        const creator = await identity.createUser({
          email: "c@example.com",
          name: "C",
        });
        const { invitation, token } = await identity.createInvitation({
          email: "Guest@Example.com",
          data: { kind: "org", orgId: "o1", role: "member" },
          createdBy: creator.id,
        });
        expect(invitation).toMatchObject({
          email: "guest@example.com",
          data: { kind: "org", orgId: "o1", role: "member" },
          createdBy: creator.id,
        });
        expect(invitation.expiresAt - invitation.createdAt).toBe(7 * DAY);
        expect(await identity.findInvitation(token)).toEqual(invitation);
        expect(await identity.findInvitation("no-such-token")).toBeUndefined();
        expect(await identity.listInvitations()).toEqual([invitation]);
        const open = await identity.createInvitation({ data: null });
        expect(open.invitation.email).toBeUndefined();
        expect(open.invitation.createdBy).toBeUndefined();
        expect(open.token).not.toBe(token);
      },
    },
    {
      name: "an invitation can be consumed once",
      async check(identity) {
        const user = await identity.createUser({
          email: "g@example.com",
          name: "G",
        });
        const { invitation, token } = await identity.createInvitation({
          data: { n: 1 },
        });
        expect(await identity.consumeInvitation(token, user.id)).toEqual(
          invitation,
        );
        expect(await identity.findInvitation(token)).toBeUndefined();
        expect(await identity.listInvitations()).toEqual([]);
        await expect(
          identity.consumeInvitation(token, user.id),
        ).rejects.toMatchObject({ code: "identity/invitation-not-found" });
      },
    },
    {
      name: "concurrent consumption of one invitation succeeds exactly once",
      async check(identity) {
        const a = await identity.createUser({
          email: "a@example.com",
          name: "A",
        });
        const b = await identity.createUser({
          email: "b@example.com",
          name: "B",
        });
        const { token } = await identity.createInvitation({ data: null });
        const results = await Promise.allSettled([
          identity.consumeInvitation(token, a.id),
          identity.consumeInvitation(token, b.id),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      },
    },
    {
      name: "an invitation expires after its lifetime",
      async check(identity) {
        await withFakeDate(async (advance) => {
          const user = await identity.createUser({
            email: "late@example.com",
            name: "L",
          });
          const fallback = await identity.createInvitation({ data: null });
          const short = await identity.createInvitation({
            data: null,
            ttlMs: 1000,
          });
          advance(1000);
          expect(await identity.findInvitation(short.token)).toBeUndefined();
          await expect(
            identity.consumeInvitation(short.token, user.id),
          ).rejects.toMatchObject({ code: "identity/invitation-not-found" });
          expect(await identity.listInvitations()).toEqual([
            fallback.invitation,
          ]);
          advance(7 * DAY - 1000);
          expect(await identity.findInvitation(fallback.token)).toBeUndefined();
        });
      },
    },
    {
      name: "an invitation for an email cannot be consumed by a user with another email",
      async check(identity) {
        const other = await identity.createUser({
          email: "other@example.com",
          name: "O",
        });
        const invited = await identity.createUser({
          email: "invited@example.com",
          name: "I",
        });
        const { token } = await identity.createInvitation({
          email: "INVITED@example.com",
          data: null,
        });
        await expect(
          identity.consumeInvitation(token, other.id),
        ).rejects.toMatchObject({ code: "identity/invitation-email-mismatch" });
        expect(await identity.findInvitation(token)).toBeDefined();
        await identity.consumeInvitation(token, invited.id);
      },
    },
    {
      name: "a revoked invitation is gone",
      async check(identity) {
        const user = await identity.createUser({
          email: "r@example.com",
          name: "R",
        });
        const kept = await identity.createInvitation({ data: 1 });
        const revoked = await identity.createInvitation({ data: 2 });
        await identity.revokeInvitation(revoked.invitation.id);
        expect(await identity.findInvitation(revoked.token)).toBeUndefined();
        await expect(
          identity.consumeInvitation(revoked.token, user.id),
        ).rejects.toMatchObject({ code: "identity/invitation-not-found" });
        expect(await identity.listInvitations()).toEqual([kept.invitation]);
      },
    },
  ],
);
