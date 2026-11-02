import { DocleusError, type Context } from "@docleus/kernel";
import { z } from "zod";
import { handle, json, readBody } from "./respond.ts";

export const DEV_PROVIDER = "dev";

const devCredentials = z.object({ email: z.email() });

/**
 * Development only (`docleus serve --dev`): anyone may sign in with any
 * email and becomes an instance admin. The response also carries the
 * session token, for tests that call the API directly.
 */
export function registerDevIdentity(ctx: Context): void {
  ctx
    .logger("dev-identity")
    .warn(
      "development login is enabled: any email logs in as an instance admin",
    );
  ctx.identity.registerProvider(DEV_PROVIDER, {
    async authenticate(credentials) {
      const parsed = devCredentials.safeParse(credentials);
      if (!parsed.success) return undefined;
      const email = parsed.data.email.toLowerCase();
      return {
        email,
        name: email.split("@")[0] ?? email,
        isEmailVerified: true,
      };
    },
  });

  ctx.http.route(
    "POST",
    "/api/auth/dev-login",
    handle(ctx, async ({ request }) => {
      const credentials = await readBody(request, devCredentials);
      const result = await ctx.identity.login(DEV_PROVIDER, credentials, {
        allowSignup: true,
      });
      if (!result) {
        throw new DocleusError("auth/invalid-credentials", "login failed");
      }
      await ctx.authz.grant(result.user.id, { kind: "instance" }, "admin");
      return json(result, 200, {
        "set-cookie": ctx.http.sessionCookie(request, result.token),
      });
    }),
    { public: true },
  );
}
