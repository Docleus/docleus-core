import {
  DEFAULT_SESSION_TTL_MS,
  type ExternalIdentity,
  type IdentityProvider,
  type IdentityService,
  type Invitation,
  type User,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { identityConformanceSuite } from "./identity.ts";
import { checkInvariant, runConformanceSuite } from "./suite.ts";

type Bug =
  | "logout-noop"
  | "no-session-expiry"
  | "links-unverified"
  | "signup-always"
  | "reusable-invitation"
  | "ignores-invitation-email"
  | "case-sensitive-email"
  | "no-password-limits"
  | "get-users-keeps-unknown";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** An in-memory implementation that passes the suite unless `bug` is set. */
function createInMemoryIdentity(bug?: Bug): IdentityService {
  const providers = new Map<string, IdentityProvider>();
  const users = new Map<string, User>();
  const passwords = new Map<string, string>();
  const links = new Map<string, string>();
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const invitations = new Map<
    string,
    { invitation: Invitation; isUsed: boolean }
  >();
  let counter = 0;
  const nextId = () => `id-${(counter += 1)}`;
  const email = (value: string) =>
    bug === "case-sensitive-email" ? value.trim() : value.trim().toLowerCase();
  const byEmail = (value: string) =>
    [...users.values()].find((user) => user.email === email(value));
  const checkPassword = (password: string) => {
    if (
      bug !== "no-password-limits" &&
      (password.length < 8 || password.length > 256)
    ) {
      throw codedError("identity/invalid-password");
    }
  };
  const addUser = (input: { email: string; name: string }) => {
    const user: User = {
      id: nextId(),
      email: email(input.email),
      name: input.name,
      hasPassword: false,
    };
    users.set(user.id, user);
    return user;
  };
  const session = (userId: string, ttlMs = DEFAULT_SESSION_TTL_MS) => {
    const token = `token-${nextId()}`;
    sessions.set(token, { userId, expiresAt: Date.now() + ttlMs });
    return token;
  };
  const active = (token: string) => {
    const entry = invitations.get(token);
    return entry &&
      (bug === "reusable-invitation" || !entry.isUsed) &&
      entry.invitation.expiresAt > Date.now()
      ? entry
      : undefined;
  };
  const resolve = (
    providerId: string,
    identity: ExternalIdentity,
    allowSignup: boolean,
  ) => {
    const link = `${providerId}|${identity.subject ?? email(identity.email)}`;
    const linkedId = links.get(link);
    if (linkedId !== undefined) return users.get(linkedId);
    let user = byEmail(identity.email);
    if (user && !identity.isEmailVerified && bug !== "links-unverified") {
      return undefined;
    }
    if (!user && (allowSignup || bug === "signup-always")) {
      user = addUser(identity);
    }
    if (user) links.set(link, user.id);
    return user;
  };

  const service: IdentityService = {
    registerProvider(id, provider) {
      if (providers.has(id)) throw codedError("identity/provider-taken");
      providers.set(id, provider);
      return () => providers.delete(id);
    },
    providers() {
      return [...providers].flatMap(([id, provider]) =>
        provider.display ? [{ id, display: provider.display }] : [],
      );
    },
    async login(providerId, credentials, options = {}) {
      const identity = await providers
        .get(providerId)
        ?.authenticate(credentials);
      if (!identity) return undefined;
      const user = resolve(providerId, identity, options.allowSignup ?? false);
      if (!user) return undefined;
      return { token: session(user.id, options.session?.ttlMs), user };
    },
    async resolveExternal(providerId, identity, options = {}) {
      return resolve(providerId, identity, options.allowSignup ?? false);
    },
    async createUser(input) {
      if (input.password !== undefined) checkPassword(input.password);
      if (byEmail(input.email)) throw codedError("identity/email-taken");
      const user = addUser(input);
      if (input.password === undefined) return user;
      passwords.set(user.id, input.password);
      const withPassword = { ...user, hasPassword: true };
      users.set(user.id, withPassword);
      return withPassword;
    },
    async getUser(id) {
      return users.get(id);
    },
    async getUsers(ids) {
      const found = [...new Set(ids)].map((id) => users.get(id));
      if (bug === "get-users-keeps-unknown") return found as never;
      return found.filter((user) => user !== undefined);
    },
    async findUserByEmail(value) {
      return byEmail(value);
    },
    async listUsers() {
      return [...users.values()];
    },
    async countUsers() {
      return users.size;
    },
    async updateUser(id, patch) {
      const user = users.get(id);
      if (!user) throw codedError("identity/user-not-found");
      const updated = { ...user, name: patch.name ?? user.name };
      users.set(id, updated);
      return updated;
    },
    async setPassword(userId, password) {
      const user = users.get(userId);
      if (!user) throw codedError("identity/user-not-found");
      if (password === undefined) passwords.delete(userId);
      else {
        checkPassword(password);
        passwords.set(userId, password);
      }
      users.set(userId, { ...user, hasPassword: password !== undefined });
    },
    async verifyPassword(value, password) {
      const user = byEmail(value);
      return user && passwords.get(user.id) === password ? user : undefined;
    },
    async createSession(userId, options = {}) {
      return session(userId, options.ttlMs);
    },
    async authenticate(token) {
      const entry = sessions.get(token);
      if (!entry) return undefined;
      if (bug !== "no-session-expiry" && entry.expiresAt <= Date.now()) {
        return undefined;
      }
      return users.get(entry.userId);
    },
    async logout(token) {
      if (bug !== "logout-noop") sessions.delete(token);
    },
    async logoutAll(userId) {
      for (const [token, entry] of sessions) {
        if (entry.userId === userId) sessions.delete(token);
      }
    },
    async createInvitation(input) {
      const createdAt = Date.now();
      const invitation: Invitation = {
        id: nextId(),
        email: input.email === undefined ? undefined : email(input.email),
        data: input.data,
        createdBy: input.createdBy,
        createdAt,
        expiresAt: createdAt + (input.ttlMs ?? INVITATION_TTL_MS),
      };
      const token = `invite-${nextId()}`;
      invitations.set(token, { invitation, isUsed: false });
      return { invitation, token };
    },
    async findInvitation(token) {
      return active(token)?.invitation;
    },
    async listInvitations() {
      return [...invitations.keys()].flatMap((token) => {
        const entry = active(token);
        return entry ? [entry.invitation] : [];
      });
    },
    async consumeInvitation(token, userId) {
      const entry = active(token);
      if (!entry) throw codedError("identity/invitation-not-found");
      const user = users.get(userId);
      if (!user) throw codedError("identity/user-not-found");
      if (
        bug !== "ignores-invitation-email" &&
        entry.invitation.email !== undefined &&
        entry.invitation.email !== user.email
      ) {
        throw codedError("identity/invitation-email-mismatch");
      }
      entry.isUsed = true;
      return entry.invitation;
    },
    async revokeInvitation(id) {
      for (const [token, entry] of invitations) {
        if (entry.invitation.id === id) invitations.delete(token);
      }
    },
  };
  return service;
}

describe("the in-memory reference implementation", () => {
  runConformanceSuite(identityConformanceSuite, () => createInMemoryIdentity());
});

describe("deliberately broken identity implementations", () => {
  const cases: [Bug, string[]][] = [
    [
      "get-users-keeps-unknown",
      ["getUsers returns the users that exist among the ids, once each"],
    ],
    [
      "logout-noop",
      [
        "logout invalidates the token, and the token cannot be reused afterwards",
      ],
    ],
    [
      "no-session-expiry",
      [
        "a session expires after its lifetime, 30 days by default",
        "login honours the session lifetime option",
      ],
    ],
    [
      "links-unverified",
      [
        "an identity with an unverified email is never linked to an existing user, even with signup allowed",
      ],
    ],
    [
      "signup-always",
      [
        "login without allowSignup does not create a user",
        "resolveExternal creates a user only when signup is allowed",
      ],
    ],
    ["reusable-invitation", ["an invitation can be consumed once"]],
    [
      "ignores-invitation-email",
      [
        "an invitation for an email cannot be consumed by a user with another email",
      ],
    ],
    [
      "case-sensitive-email",
      ["createUser lowercases the email and rejects a taken one"],
    ],
    [
      "no-password-limits",
      ["a password shorter than 8 or longer than 256 characters is rejected"],
    ],
  ];
  for (const [bug, names] of cases) {
    it(`rejects "${bug}"`, async () => {
      for (const name of names) {
        const invariant = identityConformanceSuite.invariants.find(
          (candidate) => candidate.name === name,
        );
        if (!invariant) throw new Error(`expected invariant "${name}"`);
        await expect(
          checkInvariant(invariant, () => createInMemoryIdentity(bug)),
        ).rejects.toThrow();
      }
    });
  }
});
