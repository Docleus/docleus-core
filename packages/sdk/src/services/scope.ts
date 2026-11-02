import { DocleusError } from "@docleus/kernel";

/**
 * Where a grant, setting or plugin enablement applies: the whole instance, an organization, or one space.
 */
export type Scope =
  | { readonly kind: "instance" }
  | { readonly kind: "org"; readonly orgId: string }
  | {
      readonly kind: "space";
      readonly orgId: string;
      readonly spaceId: string;
    };

/** Who performs a request: a signed-in user or an anonymous visitor. */
export type Actor =
  | { readonly kind: "anonymous" }
  | { readonly kind: "user"; readonly userId: string };

/** The actor of requests without a valid session. */
export const ANONYMOUS: Actor = { kind: "anonymous" };

const ID_PATTERN = /^[0-9A-Za-z_-]+$/;

/**
 * A stable string key for `scope`, such as `space:<orgId>:<spaceId>`.
 * Throws `scope/invalid-id` for ids outside `[0-9A-Za-z_-]`.
 */
export function scopeKey(scope: Scope): string {
  if (scope.kind === "instance") return "instance";
  assertId(scope.orgId);
  if (scope.kind === "org") return `org:${scope.orgId}`;
  assertId(scope.spaceId);
  return `space:${scope.orgId}:${scope.spaceId}`;
}

/** Throws `scope/invalid-id` unless `id` only uses `[0-9A-Za-z_-]`. */
export function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new DocleusError("scope/invalid-id", `invalid id "${id}"`);
  }
}
