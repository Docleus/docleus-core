import { createHash, timingSafeEqual } from "node:crypto";
import { DocleusError, type Context } from "@docleus/kernel";
import type { User } from "@docleus/sdk";
import { z } from "zod";
import {
  applyOrgInvitation,
  findOrgInvitation,
  type Serial,
} from "./members.ts";
import { createFailureLimiter } from "./rate-limit.ts";
import { handle, json, readBody, userOf } from "./respond.ts";
import { sessionToken } from "./session.ts";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_ADDRESS = 50;

const loginBody = z.object({ email: z.string(), password: z.string() });
const setupBody = z.object({
  token: z.string(),
  email: z.email(),
  name: z.string().trim().min(1),
  password: z.string(),
});
const signupBody = z.object({
  invitation: z.string().min(1),
  name: z.string().trim().min(1),
  password: z.string(),
  email: z.email().optional(),
});
const passwordBody = z.object({
  current: z.string().optional(),
  password: z.string(),
});

export interface AuthApiOptions {
  readonly isDev: boolean;
  /** The one-time token `/setup` requires; undefined when setup is not offered. */
  readonly setupToken: string | undefined;
  readonly publicUrl: string | undefined;
  readonly now: () => number;
  readonly serial: Serial;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Sign-in, sign-out, first-run setup, signup by invitation and password
 * changes. Every sign-in sets the session cookie and answers `{ user }`.
 */
export function registerAuthApi(ctx: Context, options: AuthApiOptions): void {
  const { serial } = options;
  const failures = createFailureLimiter(
    ctx.storage,
    LOGIN_WINDOW_MS,
    options.now,
  );
  let setupToken = options.setupToken;
  if (setupToken !== undefined) {
    ctx
      .logger("setup")
      .info(
        `no users yet: open ${options.publicUrl?.replace(/\/+$/, "") ?? ""}/setup and enter the setup token ${setupToken}`,
      );
  }

  const isSetupRequired = async () =>
    !options.isDev && (await ctx.identity.countUsers()) === 0;

  async function signedIn(
    request: Request,
    user: User,
    status = 200,
  ): Promise<Response> {
    const token = await ctx.identity.createSession(user.id);
    return json({ user }, status, {
      "set-cookie": ctx.http.sessionCookie(request, token),
    });
  }

  ctx.http.route(
    "GET",
    "/api/auth/methods",
    handle(ctx, async () =>
      json({
        password: true,
        dev: options.isDev,
        providers: ctx.identity.providers(),
        setupRequired: await isSetupRequired(),
      }),
    ),
    { public: true },
  );

  ctx.http.route(
    "POST",
    "/api/auth/login",
    handle(ctx, async ({ request, clientAddress }) => {
      const input = await readBody(request, loginBody);
      const email = input.email.trim().toLowerCase();
      const address = clientAddress ?? "unknown";
      const accountKey = JSON.stringify(["account", email, address]);
      const addressKey = JSON.stringify(["address", address]);
      const admission = await failures.admit([
        { key: accountKey, max: MAX_FAILURES_PER_ACCOUNT },
        { key: addressKey, max: MAX_FAILURES_PER_ADDRESS },
      ]);
      if (!admission.isAllowed) {
        return json(
          { code: "auth/rate-limited", message: "too many failed sign-ins" },
          429,
          { "retry-after": String(admission.retryAfterSeconds) },
        );
      }
      const user = await ctx.identity.verifyPassword(email, input.password);
      if (!user) {
        throw new DocleusError(
          "auth/invalid-credentials",
          "wrong email or password",
        );
      }
      await failures.clear(accountKey);
      await failures.forgive(admission.failureIds);
      return signedIn(request, user);
    }),
    { public: true },
  );

  ctx.http.route(
    "POST",
    "/api/auth/logout",
    handle(ctx, async ({ request }) => {
      const token = sessionToken(request);
      if (token) await ctx.identity.logout(token);
      return json({ ok: true }, 200, {
        "set-cookie": ctx.http.sessionCookie(request, undefined),
      });
    }),
    { public: true },
  );

  ctx.http.route(
    "GET",
    "/api/setup",
    handle(ctx, async () => json({ required: await isSetupRequired() })),
    { public: true },
  );

  ctx.http.route(
    "POST",
    "/api/setup",
    handle(ctx, async ({ request }) => {
      const input = await readBody(request, setupBody);
      const user = await serial(async () => {
        if ((await ctx.identity.countUsers()) > 0) {
          throw new DocleusError(
            "setup/already-done",
            "the instance is already set up",
          );
        }
        if (setupToken === undefined || !sameSecret(input.token, setupToken)) {
          throw new DocleusError("setup/invalid-token", "wrong setup token");
        }
        const created = await ctx.identity.createUser({
          email: input.email,
          name: input.name,
          password: input.password,
        });
        await ctx.authz.grant(created.id, { kind: "instance" }, "admin");
        setupToken = undefined;
        return created;
      });
      return signedIn(request, user, 201);
    }),
    { public: true },
  );

  ctx.http.route(
    "POST",
    "/api/auth/signup",
    handle(ctx, async ({ request }) => {
      const input = await readBody(request, signupBody);
      const user = await serial(async () => {
        const { invitation, data } = await findOrgInvitation(
          ctx,
          input.invitation,
        );
        const email = invitation.email ?? input.email;
        if (email === undefined) {
          throw new DocleusError(
            "api/invalid-request",
            "an email is required for this invitation",
          );
        }
        const created = await ctx.identity.createUser({
          email,
          name: input.name,
          password: input.password,
        });
        await ctx.identity.consumeInvitation(input.invitation, created.id);
        await applyOrgInvitation(ctx, created.id, data);
        return created;
      });
      return signedIn(request, user, 201);
    }),
    { public: true },
  );

  ctx.http.route(
    "PUT",
    "/api/me/password",
    handle(ctx, async (context) => {
      const input = await readBody(context.request, passwordBody);
      const user = await userOf(ctx, context.actor);
      if (user.hasPassword) {
        const verified =
          input.current === undefined
            ? undefined
            : await ctx.identity.verifyPassword(user.email, input.current);
        if (verified?.id !== user.id) {
          throw new DocleusError(
            "account/wrong-password",
            "the current password is wrong",
          );
        }
      }
      await ctx.identity.setPassword(user.id, input.password);
      await ctx.identity.logoutAll(user.id);
      return signedIn(
        context.request,
        (await ctx.identity.getUser(user.id)) ?? user,
      );
    }),
  );
}
