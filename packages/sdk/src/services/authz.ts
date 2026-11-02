import type { Actor, Scope } from "./scope.ts";

/** Roles that can be granted at instance level. */
export type InstanceRole = "admin";
/** Roles that can be granted on an organization. */
export type OrgRole = "owner" | "admin" | "member";
/** Roles that can be granted on a space. */
export type SpaceRole = "admin" | "editor" | "viewer";
/** Any role that can be granted at some scope. */
export type Role = InstanceRole | OrgRole | SpaceRole;

/** The roles that can be granted at a scope of kind `S`. */
export type RoleAt<S extends Scope> = S extends { readonly kind: "instance" }
  ? InstanceRole
  : S extends { readonly kind: "org" }
    ? OrgRole
    : SpaceRole;

/**
 * What an actor wants to do: `read`, `write`, or `manage` (settings, members, plugins).
 */
export type Action = "read" | "write" | "manage";

/** A role granted to a user at exactly one scope. */
export interface Grant<S extends Scope = Scope> {
  readonly userId: string;
  readonly scope: S;
  readonly role: RoleAt<S>;
}

/**
 * Role grants at instance, org and space level.
 *
 * What a role allows, inherited downward to every scope below the grant:
 * instance `admin` allows every action everywhere; org `owner` and `admin`
 * allow every action on the org and its spaces; org `member` allows `read`
 * on the org and its spaces; space `admin` allows every action on the space,
 * `editor` allows `read` and `write`, `viewer` allows `read`. A space grant
 * also allows `read` on its org, so a guest can open the org they were
 * invited to. Telling `owner` apart from `admin` is up to the caller
 * (`roleAt`), for example to keep an org from losing its last owner.
 *
 * @stability experimental
 */
export interface AuthzService {
  /** Replaces the user's role at exactly this scope. Throws `authz/invalid-role` for a role the scope does not take. */
  grant<S extends Scope>(
    userId: string,
    scope: S,
    role: RoleAt<S>,
  ): Promise<void>;
  revoke(userId: string, scope: Scope): Promise<void>;
  /** The role granted directly at exactly this scope, not inherited. */
  roleAt<S extends Scope>(
    userId: string,
    scope: S,
  ): Promise<RoleAt<S> | undefined>;
  /** Grants made directly at exactly this scope, in no particular order. */
  listGrants<S extends Scope>(scope: S): Promise<Grant<S>[]>;
  /** Every grant the user holds, at any scope. */
  listUserGrants(userId: string): Promise<Grant[]>;
  /** Removes every grant at this scope and the scopes below it, for example when an org is deleted. */
  revokeAll(scope: Scope): Promise<void>;
  /**
   * Whether `actor` may perform `action` on `resource`, given every grant at
   * that scope and the scopes above it. Anonymous actors, users without a
   * grant, and users that `identity` no longer knows (whatever grants they
   * still hold) are denied.
   */
  can(actor: Actor, action: Action, resource: Scope): Promise<boolean>;
  /**
   * `can` for every resource at once, in the order given, for listing many
   * resources without one lookup per resource.
   */
  canEach(
    actor: Actor,
    action: Action,
    resources: readonly Scope[],
  ): Promise<boolean[]>;
}
