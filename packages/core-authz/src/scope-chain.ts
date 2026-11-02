import { DocleusError } from "@docleus/kernel";
import { scopeKey, type Scope } from "@docleus/sdk";

const INSTANCE: Scope = { kind: "instance" };

/**
 * `scope` and every ancestor scope that a grant on it would also apply to:
 * a space's chain is [space, org, instance]; org's is [org, instance].
 */
export function scopeChain(scope: Scope): Scope[] {
  if (scope.kind === "instance") return [INSTANCE];
  if (scope.kind === "org") return [scope, INSTANCE];
  return [scope, { kind: "org", orgId: scope.orgId }, INSTANCE];
}

/** The inverse of `scopeKey`, for keys read back from storage. */
export function parseScopeKey(key: string): Scope {
  const parts = key.split(":");
  const [kind, orgId, spaceId] = parts;
  let scope: Scope | undefined;
  if (kind === "instance" && parts.length === 1) scope = INSTANCE;
  else if (kind === "org" && parts.length === 2 && orgId !== undefined)
    scope = { kind: "org", orgId };
  else if (
    kind === "space" &&
    parts.length === 3 &&
    orgId !== undefined &&
    spaceId !== undefined
  )
    scope = { kind: "space", orgId, spaceId };
  if (!scope || scopeKey(scope) !== key) {
    throw new DocleusError(
      "authz/invalid-scope",
      `stored scope "${key}" is not a valid scope`,
    );
  }
  return scope;
}

/**
 * Bounds of the keys of every space in `orgId`, as a half-open range
 * `[from, to)`. A range instead of `LIKE` because ids may contain `_`.
 */
export function orgSpaceKeyRange(orgId: string): { from: string; to: string } {
  const orgKey = scopeKey({ kind: "org", orgId });
  const prefix = `space:${orgKey.slice("org:".length)}:`;
  // ";" is the character right after ":", so every key with the prefix sorts below it.
  return { from: prefix, to: `${prefix.slice(0, -1)};` };
}
