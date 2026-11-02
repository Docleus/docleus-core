import { DocleusError, type Context } from "@docleus/kernel";
import type {
  Actor,
  HttpRequestContext,
  Invitation,
  Org,
  OrgRole,
  User,
} from "@docleus/sdk";
import { z } from "zod";
import type { Mailer } from "../mailer.ts";
import {
  assertCan,
  handle,
  json,
  param,
  readBody,
  requireSpace,
} from "./respond.ts";
import { publicOrigin, type OriginOptions } from "./session.ts";

const ORG_ROLES = ["owner", "admin", "member"] as const;
const SPACE_ROLES = ["admin", "editor", "viewer"] as const;
const ORG_ROLE_RANK: Readonly<Record<OrgRole, number>> = {
  member: 0,
  admin: 1,
  owner: 2,
};

const orgRole = z.enum(ORG_ROLES);
const orgInvitationData = z.object({
  kind: z.literal("org"),
  orgId: z.string().min(1),
  role: orgRole,
});
export type OrgInvitationData = z.output<typeof orgInvitationData>;

const orgRoleBody = z.object({ role: orgRole });
const spaceRoleBody = z.object({ role: z.enum(SPACE_ROLES) });
const inviteBody = z.object({ email: z.email().optional(), role: orgRole });
const adminBody = z.object({ isAdmin: z.boolean() });

export type Serial = <T>(task: () => Promise<T>) => Promise<T>;

export interface MembersApiOptions extends OriginOptions {
  readonly mailer?: Mailer | undefined;
  /** Shared with signup, so invitation and membership changes never interleave. */
  readonly serial: Serial;
}

function presentUser(user: User) {
  return { id: user.id, email: user.email, name: user.name };
}

function presentInvitation(invitation: Invitation, data: OrgInvitationData) {
  return {
    id: invitation.id,
    email: invitation.email ?? null,
    role: data.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  };
}

function invitationNotFound(): DocleusError {
  return new DocleusError(
    "invitations/not-found",
    "the invitation does not exist, was used or expired",
  );
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

async function requireOrg(ctx: Context, orgId: string): Promise<Org> {
  const org = await ctx.content.getOrg(orgId);
  if (!org) {
    throw new DocleusError(
      "api/org-not-found",
      `org "${orgId}" does not exist`,
    );
  }
  return org;
}

async function requireUser(ctx: Context, userId: string): Promise<User> {
  const user = await ctx.identity.getUser(userId);
  if (!user) {
    throw new DocleusError(
      "members/user-not-found",
      `user "${userId}" does not exist`,
    );
  }
  return user;
}

/** A usable org invitation for `token`, with its validated data and org. */
export async function findOrgInvitation(
  ctx: Context,
  token: string,
): Promise<{ invitation: Invitation; data: OrgInvitationData; org: Org }> {
  const invitation = await ctx.identity.findInvitation(token);
  const parsed = orgInvitationData.safeParse(invitation?.data);
  if (!invitation || !parsed.success) throw invitationNotFound();
  const org = await ctx.content.getOrg(parsed.data.orgId);
  if (!org) throw invitationNotFound();
  return { invitation, data: parsed.data, org };
}

/** Grants the invited role, keeping a higher role the user already has. */
export async function applyOrgInvitation(
  ctx: Context,
  userId: string,
  data: OrgInvitationData,
): Promise<void> {
  const scope = { kind: "org", orgId: data.orgId } as const;
  const current = await ctx.authz.roleAt(userId, scope);
  if (
    current !== undefined &&
    ORG_ROLE_RANK[current] >= ORG_ROLE_RANK[data.role]
  )
    return;
  await ctx.authz.grant(userId, scope, data.role);
}

/**
 * Org members and invitations, space members and instance admins. Every
 * route checks the caller's role before revealing whether the target exists.
 */
export function registerMembersApi(
  ctx: Context,
  options: MembersApiOptions,
): void {
  const { serial } = options;

  async function canManageOwners(actor: Actor, orgId: string) {
    if (actor.kind !== "user") return false;
    if (await ctx.authz.can(actor, "manage", { kind: "instance" })) return true;
    return (
      (await ctx.authz.roleAt(actor.userId, { kind: "org", orgId })) === "owner"
    );
  }

  async function assertCanManageOwners(actor: Actor, orgId: string) {
    if (!(await canManageOwners(actor, orgId))) {
      throw new DocleusError(
        "api/forbidden",
        "only an owner can grant or remove the owner role",
      );
    }
  }

  /** Throws when taking `userId`'s owner role would leave the org without one. */
  async function assertNotLastOwner(orgId: string, userId: string) {
    const owners = (await ctx.authz.listGrants({ kind: "org", orgId })).filter(
      (grant) => grant.role === "owner",
    );
    if (owners.length === 1 && owners[0]?.userId === userId) {
      throw new DocleusError(
        "members/last-owner",
        "an organization needs at least one owner",
      );
    }
  }

  async function orgFromParams(
    context: HttpRequestContext,
    action: "read" | "manage",
  ) {
    const orgId = param(context, "orgId");
    await assertCan(ctx, context.actor, action, { kind: "org", orgId });
    return requireOrg(ctx, orgId);
  }

  async function orgInvitations(orgId: string) {
    const out = [];
    for (const invitation of await ctx.identity.listInvitations()) {
      const parsed = orgInvitationData.safeParse(invitation.data);
      if (parsed.success && parsed.data.orgId === orgId) {
        out.push({ invitation, data: parsed.data });
      }
    }
    return out;
  }

  async function sendInvitation(to: string, org: Org, url: string) {
    if (!options.mailer) return false;
    try {
      await options.mailer.send({
        to,
        subject: `You are invited to ${org.name} on Docleus`,
        text: `You are invited to join ${org.name} on Docleus.\n\nOpen this link to accept the invitation:\n${url}\n`,
      });
      return true;
    } catch (error) {
      ctx
        .logger("members")
        .warn(
          "could not email an invitation to %s: %s",
          org.name,
          error instanceof Error ? error.message : String(error),
        );
      return false;
    }
  }

  /** Grants with their users, by email; grants of users that are gone are left out. */
  async function presentMembers<R>(
    grants: readonly { userId: string; role: R }[],
  ): Promise<{ user: ReturnType<typeof presentUser>; role: R }[]> {
    const users = new Map(
      (await ctx.identity.getUsers(grants.map((grant) => grant.userId))).map(
        (user) => [user.id, user],
      ),
    );
    const members = [];
    for (const grant of grants) {
      const user = users.get(grant.userId);
      if (user) members.push({ user: presentUser(user), role: grant.role });
    }
    members.sort((a, b) => a.user.email.localeCompare(b.user.email));
    return members;
  }

  ctx.http.route(
    "GET",
    "/api/orgs/:orgId/members",
    handle(ctx, async (context) => {
      const org = await orgFromParams(context, "read");
      const members = await presentMembers(
        await ctx.authz.listGrants({ kind: "org", orgId: org.id }),
      );
      return json({ members });
    }),
  );

  ctx.http.route(
    "PUT",
    "/api/orgs/:orgId/members/:userId",
    handle(ctx, async (context) => {
      const org = await orgFromParams(context, "manage");
      const { role } = await readBody(context.request, orgRoleBody);
      const user = await requireUser(ctx, param(context, "userId"));
      const scope = { kind: "org", orgId: org.id } as const;
      await serial(async () => {
        const current = await ctx.authz.roleAt(user.id, scope);
        if (current === role) return;
        if (role === "owner" || current === "owner") {
          await assertCanManageOwners(context.actor, org.id);
        }
        if (current === "owner") await assertNotLastOwner(org.id, user.id);
        await ctx.authz.grant(user.id, scope, role);
      });
      return json({ member: { user: presentUser(user), role } });
    }),
  );

  ctx.http.route(
    "DELETE",
    "/api/orgs/:orgId/members/:userId",
    handle(ctx, async (context) => {
      const orgId = param(context, "orgId");
      const userId = param(context, "userId");
      const isSelf =
        context.actor.kind === "user" && context.actor.userId === userId;
      if (!isSelf) {
        await assertCan(ctx, context.actor, "manage", { kind: "org", orgId });
      }
      await requireOrg(ctx, orgId);
      const scope = { kind: "org", orgId } as const;
      await serial(async () => {
        if ((await ctx.authz.roleAt(userId, scope)) === "owner") {
          await assertCanManageOwners(context.actor, orgId);
          await assertNotLastOwner(orgId, userId);
        }
        await ctx.authz.revoke(userId, scope);
        for (const grant of await ctx.authz.listUserGrants(userId)) {
          if (grant.scope.kind === "space" && grant.scope.orgId === orgId) {
            await ctx.authz.revoke(userId, grant.scope);
          }
        }
      });
      return noContent();
    }),
  );

  ctx.http.route(
    "GET",
    "/api/orgs/:orgId/invitations",
    handle(ctx, async (context) => {
      const org = await orgFromParams(context, "manage");
      const invitations = (await orgInvitations(org.id))
        .map(({ invitation, data }) => presentInvitation(invitation, data))
        .toSorted((a, b) => a.createdAt - b.createdAt);
      return json({ invitations });
    }),
  );

  ctx.http.route(
    "POST",
    "/api/orgs/:orgId/invitations",
    handle(ctx, async (context) => {
      const org = await orgFromParams(context, "manage");
      const input = await readBody(context.request, inviteBody);
      if (input.role === "owner") {
        await assertCanManageOwners(context.actor, org.id);
      }
      const data: OrgInvitationData = {
        kind: "org",
        orgId: org.id,
        role: input.role,
      };
      const { invitation, token } = await ctx.identity.createInvitation({
        data,
        ...(input.email !== undefined && { email: input.email }),
        ...(context.actor.kind === "user" && {
          createdBy: context.actor.userId,
        }),
      });
      const url = `${publicOrigin(context.request, options)}/invitations/${token}`;
      const emailed =
        invitation.email === undefined
          ? false
          : await sendInvitation(invitation.email, org, url);
      return json(
        { invitation: presentInvitation(invitation, data), url, emailed },
        201,
      );
    }),
  );

  ctx.http.route(
    "DELETE",
    "/api/orgs/:orgId/invitations/:id",
    handle(ctx, async (context) => {
      const org = await orgFromParams(context, "manage");
      const id = param(context, "id");
      const found = (await orgInvitations(org.id)).some(
        ({ invitation }) => invitation.id === id,
      );
      if (!found) throw invitationNotFound();
      await ctx.identity.revokeInvitation(id);
      return noContent();
    }),
  );

  ctx.http.route(
    "GET",
    "/api/invitations/:token",
    handle(ctx, async (context) => {
      const { invitation, data, org } = await findOrgInvitation(
        ctx,
        param(context, "token"),
      );
      return json({
        org: { id: org.id, name: org.name },
        role: data.role,
        email: invitation.email ?? null,
        expiresAt: invitation.expiresAt,
      });
    }),
    { public: true },
  );

  ctx.http.route(
    "POST",
    "/api/invitations/:token/accept",
    handle(ctx, async (context) => {
      const token = param(context, "token");
      if (context.actor.kind !== "user") {
        throw new DocleusError("api/forbidden", "not signed in");
      }
      const { userId } = context.actor;
      const org = await serial(async () => {
        const found = await findOrgInvitation(ctx, token);
        await ctx.identity.consumeInvitation(token, userId);
        await applyOrgInvitation(ctx, userId, found.data);
        return found.org;
      });
      return json({ org });
    }),
  );

  const SPACE_MEMBERS = "/api/orgs/:orgId/spaces/:spaceId/members";

  ctx.http.route(
    "GET",
    SPACE_MEMBERS,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      const members = await presentMembers(
        await ctx.authz.listGrants({
          kind: "space",
          orgId: space.orgId,
          spaceId: space.id,
        }),
      );
      return json({ members });
    }),
  );

  ctx.http.route(
    "PUT",
    `${SPACE_MEMBERS}/:userId`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      const { role } = await readBody(context.request, spaceRoleBody);
      const user = await requireUser(ctx, param(context, "userId"));
      await ctx.authz.grant(
        user.id,
        { kind: "space", orgId: space.orgId, spaceId: space.id },
        role,
      );
      return json({ member: { user: presentUser(user), role } });
    }),
  );

  ctx.http.route(
    "DELETE",
    `${SPACE_MEMBERS}/:userId`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      await ctx.authz.revoke(param(context, "userId"), {
        kind: "space",
        orgId: space.orgId,
        spaceId: space.id,
      });
      return noContent();
    }),
  );

  const INSTANCE = { kind: "instance" } as const;
  const asAdmin = {
    authorize: { action: "manage", resource: INSTANCE },
  } as const;

  async function presentAccount(user: User) {
    return {
      ...presentUser(user),
      isAdmin: (await ctx.authz.roleAt(user.id, INSTANCE)) === "admin",
    };
  }

  ctx.http.route(
    "GET",
    "/api/users",
    handle(ctx, async () => {
      const admins = new Set(
        (await ctx.authz.listGrants(INSTANCE))
          .filter((grant) => grant.role === "admin")
          .map((grant) => grant.userId),
      );
      const users = (await ctx.identity.listUsers()).map((user) => ({
        ...presentUser(user),
        isAdmin: admins.has(user.id),
      }));
      users.sort((a, b) => a.email.localeCompare(b.email));
      return json({ users });
    }),
    asAdmin,
  );

  ctx.http.route(
    "PUT",
    "/api/users/:userId/admin",
    handle(ctx, async (context) => {
      const { isAdmin } = await readBody(context.request, adminBody);
      const user = await requireUser(ctx, param(context, "userId"));
      await serial(async () => {
        const isCurrentlyAdmin =
          (await ctx.authz.roleAt(user.id, INSTANCE)) === "admin";
        if (isAdmin === isCurrentlyAdmin) return;
        if (isAdmin) {
          await ctx.authz.grant(user.id, INSTANCE, "admin");
          return;
        }
        const admins = (await ctx.authz.listGrants(INSTANCE)).filter(
          (grant) => grant.role === "admin",
        );
        if (admins.length <= 1) {
          throw new DocleusError(
            "users/last-admin",
            "the instance needs at least one admin",
          );
        }
        await ctx.authz.revoke(user.id, INSTANCE);
      });
      return json({ user: await presentAccount(user) });
    }),
    asAdmin,
  );
}
