import { DocleusError, type Context } from "@docleus/kernel";
import type {
  Action,
  Actor,
  HttpRequestContext,
  RouteHandler,
  Scope,
  Space,
  User,
} from "@docleus/sdk";
import type { z } from "zod";

const STATUS_BY_SUFFIX: readonly (readonly [string, number])[] = [
  ["/not-found", 404],
  ["/forbidden", 403],
  ["/stale-head", 409],
  ["/slug-taken", 409],
  ["/domain-taken", 409],
  ["/space-empty", 409],
  ["/invalid-request", 400],
  ["/invalid-slug", 400],
  ["/invalid-commit", 400],
  ["/invalid-entry", 400],
  ["/invalid-document", 400],
  ["/invalid-name", 400],
  ["/invalid-type", 400],
  ["/invalid-id", 400],
  ["/invalid-domain", 400],
  ["/invalid-path", 400],
  ["/invalid-spaces", 400],
  ["/invalid-revision", 400],
  ["/not-installed", 404],
  ["/invalid-credentials", 401],
  ["/wrong-password", 403],
  ["/rate-limited", 429],
  ["/last-owner", 409],
  ["/last-admin", 409],
  ["/email-taken", 409],
  ["/invalid-token", 403],
  ["/already-done", 409],
  ["/invitation-not-found", 404],
  ["/invitation-email-mismatch", 403],
  ["/invalid-password", 400],
  ["/invalid-role", 400],
  ["/commit-rejected", 409],
  ["/branch-taken", 409],
  ["/invalid-branch", 400],
  ["/merge-conflict", 409],
  ["/invalid-resolution", 400],
  ["/not-allowed", 403],
  ["/too-large", 413],
  ["/invalid-tarball", 400],
  ["/invalid-manifest", 400],
  ["/invalid-source", 400],
  ["/engines-mismatch", 409],
  ["/already-installed", 409],
  ["/bundled", 409],
  ["/syntax-conflict", 409],
  ["/expose-conflict", 409],
  ["/island-conflict", 409],
  ["/install-failed", 422],
  ["/load-failed", 422],
  ["/rollback-failed", 500],
  ["/install-lease-lost", 409],
];

export function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return Response.json(body, { status, ...(headers && { headers }) });
}

function statusOf(code: string): number | undefined {
  if (code.endsWith("-not-found")) return 404;
  return STATUS_BY_SUFFIX.find(([suffix]) => code.endsWith(suffix))?.[1];
}

/**
 * Wraps a handler so that a `DocleusError` with a known code answers with a
 * matching status and `{ code, message }`. Other errors propagate.
 */
export function handle(
  ctx: Context,
  handler: (context: HttpRequestContext) => Promise<Response>,
): RouteHandler {
  return async (context) => {
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof DocleusError) {
        const status = statusOf(error.code);
        if (status !== undefined) {
          return json({ code: error.code, message: error.message }, status);
        }
      }
      ctx.logger("api").error(error);
      throw error;
    }
  };
}

export async function readBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  let data: unknown;
  try {
    data = await request.json();
  } catch (error) {
    throw new DocleusError("api/invalid-request", "body is not JSON", {
      cause: error,
    });
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DocleusError(
      "api/invalid-request",
      `invalid body: ${result.error.message}`,
    );
  }
  return result.data;
}

export function param(context: HttpRequestContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) {
    throw new DocleusError("api/invalid-request", `missing "${name}"`);
  }
  return value;
}

export async function assertCan(
  ctx: Context,
  actor: Actor,
  action: Action,
  scope: Scope,
): Promise<void> {
  if (!(await ctx.authz.can(actor, action, scope))) {
    throw new DocleusError("api/forbidden", `not allowed to ${action}`);
  }
}

/** Checks `action` on the space before revealing whether it exists. */
export async function requireSpace(
  ctx: Context,
  context: HttpRequestContext,
  action: Action,
): Promise<Space> {
  const orgId = param(context, "orgId");
  const spaceId = param(context, "spaceId");
  await assertCan(ctx, context.actor, action, {
    kind: "space",
    orgId,
    spaceId,
  });
  const space = (await ctx.content.listSpaces(orgId)).find(
    (candidate) => candidate.id === spaceId,
  );
  if (!space) {
    throw new DocleusError(
      "api/space-not-found",
      `space "${spaceId}" does not exist`,
    );
  }
  return space;
}

/** The signed-in user behind `actor`. */
export async function userOf(ctx: Context, actor: Actor): Promise<User> {
  const user =
    actor.kind === "user"
      ? await ctx.identity.getUser(actor.userId)
      : undefined;
  if (!user) throw new DocleusError("api/forbidden", "not signed in");
  return user;
}
