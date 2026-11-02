import { DocleusError, type Context } from "@docleus/kernel";
import type { Scope } from "@docleus/sdk";
import { z } from "zod";
import type { Frontend, MountedPlugin } from "../frontend.ts";
import {
  assertCan,
  handle,
  json,
  param,
  readBody,
  requireSpace,
} from "./respond.ts";

const SPACE = "/api/orgs/:orgId/spaces/:spaceId";

const setEnabledBody = z.object({
  plugin: z.string().min(1),
  /** `null` clears the override so the scope inherits again. */
  enabled: z.boolean().nullable(),
});

export interface PluginApiOptions {
  readonly plugins: ReadonlyMap<string, MountedPlugin>;
  readonly frontend: Frontend;
}

/**
 * Per-organization and per-space plugin enablement, and the editor entries
 * the browser loads for a space and for full-page apps.
 */
export function registerPluginApi(
  ctx: Context,
  { plugins, frontend }: PluginApiOptions,
): void {
  async function list(scope: Scope, parent?: Scope) {
    const out = [];
    for (const [name, { manifest }] of plugins) {
      out.push({
        name,
        version: manifest.version,
        hasEditor: manifest.entries.editor !== undefined,
        enabled: await ctx.installations.isEnabled(name, scope),
        ...(parent && {
          inherited: await ctx.installations.isEnabled(name, parent),
        }),
      });
    }
    return out;
  }

  async function editorsIn(scope: Scope) {
    const editors = [];
    for (const [name, { manifest }] of plugins) {
      const entry = manifest.entries.editor;
      if (!entry || !(await ctx.installations.isEnabled(name, scope))) {
        continue;
      }
      editors.push({ name, url: frontend.pluginUrl(name, entry) });
    }
    return editors;
  }

  async function setEnabled(request: Request, scope: Scope) {
    const input = await readBody(request, setEnabledBody);
    if (!plugins.has(input.plugin)) {
      throw new DocleusError(
        "api/plugin-not-found",
        `plugin "${input.plugin}" is not mounted`,
      );
    }
    await ctx.installations.setEnabled(
      input.plugin,
      scope,
      input.enabled ?? undefined,
    );
  }

  ctx.http.route(
    "GET",
    "/api/orgs/:orgId/plugins",
    handle(ctx, async (context) => {
      const scope = { kind: "org", orgId: param(context, "orgId") } as const;
      await assertCan(ctx, context.actor, "manage", scope);
      return json({ plugins: await list(scope) });
    }),
  );

  ctx.http.route(
    "PUT",
    "/api/orgs/:orgId/plugins",
    handle(ctx, async (context) => {
      const scope = { kind: "org", orgId: param(context, "orgId") } as const;
      await assertCan(ctx, context.actor, "manage", scope);
      await setEnabled(context.request, scope);
      return json({ plugins: await list(scope) });
    }),
  );

  ctx.http.route(
    "GET",
    `${SPACE}/plugins`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      const scope = {
        kind: "space",
        orgId: space.orgId,
        spaceId: space.id,
      } as const;
      return json({
        plugins: await list(scope, { kind: "org", orgId: space.orgId }),
      });
    }),
  );

  ctx.http.route(
    "PUT",
    `${SPACE}/plugins`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "manage");
      const scope = {
        kind: "space",
        orgId: space.orgId,
        spaceId: space.id,
      } as const;
      await setEnabled(context.request, scope);
      return json({
        plugins: await list(scope, { kind: "org", orgId: space.orgId }),
      });
    }),
  );

  ctx.http.route(
    "GET",
    `${SPACE}/frontend`,
    handle(ctx, async (context) => {
      const space = await requireSpace(ctx, context, "read");
      const scope = {
        kind: "space",
        orgId: space.orgId,
        spaceId: space.id,
      } as const;
      return json({ editors: await editorsIn(scope) });
    }),
  );

  ctx.http.route(
    "GET",
    "/api/orgs/:orgId/frontend",
    handle(ctx, async (context) => {
      const orgId = param(context, "orgId");
      await assertCan(ctx, context.actor, "read", { kind: "org", orgId });
      if (!(await ctx.content.getOrg(orgId))) {
        throw new DocleusError(
          "api/org-not-found",
          `org "${orgId}" does not exist`,
        );
      }
      return json({ editors: await editorsIn({ kind: "org", orgId }) });
    }),
  );

  // Full-page apps under `/apps` belong to no space, so they load the
  // editor entries of every installed plugin; each app's own API checks
  // access and enablement for the org or space it shows.
  ctx.http.route(
    "GET",
    "/api/frontend",
    handle(ctx, async () =>
      json({ editors: await editorsIn({ kind: "instance" }) }),
    ),
  );
}
