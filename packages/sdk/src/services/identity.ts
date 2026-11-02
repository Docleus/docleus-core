/** A user of the instance. */
export interface User {
  readonly id: string;
  /** Lowercased; unique across the instance. */
  readonly email: string;
  readonly name: string;
  /** Whether the user can sign in with a password. */
  readonly hasPassword: boolean;
}

/** Who an identity provider says the person signing in is. */
export interface ExternalIdentity {
  /** Stable id of the person at the provider (an OIDC `sub`); defaults to the email. */
  readonly subject?: string;
  readonly email: string;
  readonly name: string;
  /**
   * Whether the provider verified that the person owns `email`. An identity
   * that is not verified is never linked to an existing user with that email.
   */
  readonly isEmailVerified?: boolean;
}

/** How a provider is offered on the sign-in page. */
export interface ProviderDisplay {
  readonly label: string;
  /** Where the sign-in button points, for providers that sign in by redirect. */
  readonly href: string;
}

/**
 * A way to sign in, such as passwords or an OIDC issuer, registered with `identity.registerProvider`.
 */
export interface IdentityProvider {
  /** Providers without `display` are not listed on the sign-in page. */
  readonly display?: ProviderDisplay;
  authenticate(credentials: unknown): Promise<ExternalIdentity | undefined>;
}

/** A registered provider as listed on the sign-in page. */
export interface ProviderInfo {
  readonly id: string;
  readonly display: ProviderDisplay;
}

/** Options for resolving an external identity to a user. */
export interface ResolveOptions {
  /** Create a user when no user matches the identity. Defaults to false. */
  readonly allowSignup?: boolean;
}

/** Options for `identity.login`. */
export interface LoginOptions extends ResolveOptions {
  readonly session?: SessionOptions;
}

/** Options for a new session. */
export interface SessionOptions {
  /** Lifetime in milliseconds; defaults to {@link DEFAULT_SESSION_TTL_MS}. */
  readonly ttlMs?: number;
}

/** Thirty days. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Input of `identity.createUser`. */
export interface NewUser {
  readonly email: string;
  readonly name: string;
  /** Hashed with argon2id before it is stored. */
  readonly password?: string;
}

/** A one-time token that lets someone create an account, with data for whoever issued it. */
export interface Invitation {
  readonly id: string;
  /** When set, only a person with this email may use the invitation. */
  readonly email: string | undefined;
  /** Issuer-defined data, for example the org and role to grant on acceptance. */
  readonly data: unknown;
  readonly createdBy: string | undefined;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Input of `identity.createInvitation`. */
export interface NewInvitation {
  readonly email?: string;
  readonly data: unknown;
  readonly createdBy?: string;
  /** Lifetime in milliseconds; defaults to seven days. */
  readonly ttlMs?: number;
}

/**
 * Users, their sign-in methods, sessions and invitations.
 *
 * Users are matched to provider identities by `(provider, subject)`. On the
 * first sign-in through a provider, a user with the same email is linked
 * when the provider verified the email; otherwise a new user is created
 * when signup is allowed. Emails are compared lowercased.
 *
 * Session and invitation tokens are random, returned once, and stored only
 * as hashes. Expired sessions and invitations behave as if they did not exist.
 *
 * @stability experimental
 */
export interface IdentityService {
  /** Registers a provider under `id`; the returned function removes it. Throws when `id` is taken. */
  registerProvider(id: string, provider: IdentityProvider): () => void;
  /** Registered providers that have a `display`, in registration order. */
  providers(): ProviderInfo[];
  /**
   * Authenticates through a registered provider, resolves the user and
   * starts a session. Undefined when the provider is unknown, rejects the
   * credentials, or no user matches and signup is not allowed.
   */
  login(
    providerId: string,
    credentials: unknown,
    options?: LoginOptions,
  ): Promise<{ token: string; user: User } | undefined>;
  /** Finds, links or (when allowed) creates the user for an identity a provider vouched for. */
  resolveExternal(
    providerId: string,
    identity: ExternalIdentity,
    options?: ResolveOptions,
  ): Promise<User | undefined>;

  /** Throws `identity/email-taken` when a user has this email. */
  createUser(input: NewUser): Promise<User>;
  getUser(id: string): Promise<User | undefined>;
  /** The users among `ids` that exist, in no particular order; unknown ids are left out. */
  getUsers(ids: readonly string[]): Promise<User[]>;
  findUserByEmail(email: string): Promise<User | undefined>;
  listUsers(): Promise<User[]>;
  countUsers(): Promise<number>;
  updateUser(id: string, patch: { name?: string }): Promise<User>;
  /** Sets the password, or removes it with `undefined`. */
  setPassword(userId: string, password: string | undefined): Promise<void>;
  /** The user when the email and password match; takes about as long when the email is unknown. */
  verifyPassword(email: string, password: string): Promise<User | undefined>;

  createSession(userId: string, options?: SessionOptions): Promise<string>;
  /** The session's user, or undefined for an unknown or expired token. */
  authenticate(token: string): Promise<User | undefined>;
  logout(token: string): Promise<void>;
  /** Ends every session of the user, for example after a password change. */
  logoutAll(userId: string): Promise<void>;

  /** Returns the invitation and its token; the token is not stored. */
  createInvitation(
    input: NewInvitation,
  ): Promise<{ invitation: Invitation; token: string }>;
  /** The invitation for a token, while it is unused and not expired. */
  findInvitation(token: string): Promise<Invitation | undefined>;
  listInvitations(): Promise<Invitation[]>;
  /**
   * Marks the invitation used by `userId` and returns it. Throws
   * `identity/invitation-not-found` for an unknown, used or expired token,
   * and `identity/invitation-email-mismatch` when the invitation names
   * another email than the user's.
   */
  consumeInvitation(token: string, userId: string): Promise<Invitation>;
  revokeInvitation(id: string): Promise<void>;
}
