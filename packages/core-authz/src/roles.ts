import type { Action, Role, Scope } from "@docleus/sdk";

type ScopeKind = Scope["kind"];

const ALL: readonly Action[] = ["read", "write", "manage"];

const ROLE_ACTIONS: {
  readonly [K in ScopeKind]: Readonly<Record<string, readonly Action[]>>;
} = {
  instance: { admin: ALL },
  org: { owner: ALL, admin: ALL, member: ["read"] },
  space: { admin: ALL, editor: ["read", "write"], viewer: ["read"] },
};

export function isRoleAt(kind: ScopeKind, value: string): value is Role {
  return Object.hasOwn(ROLE_ACTIONS[kind], value);
}

/** What `role`, granted at a scope of `kind`, allows on that scope and the scopes below it. */
export function roleAllows(
  kind: ScopeKind,
  role: Role,
  action: Action,
): boolean {
  return ROLE_ACTIONS[kind][role]?.includes(action) ?? false;
}
