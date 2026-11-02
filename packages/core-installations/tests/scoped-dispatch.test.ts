import { Context } from "@docleus/kernel";
import { createAuthzService } from "@docleus/core-authz";
import { createContentService } from "@docleus/core-content";
import { createHttpService } from "@docleus/core-http";
import { createIdentityService } from "@docleus/core-identity";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import { definePlugin } from "@docleus/sdk";
import { expect, it } from "vitest";
import { createInstallationsService } from "../src/index.ts";

// A throwaway event: real events are declared once in @docleus/sdk.
const PAGE_VIEWED = "test/page-viewed" as never;

it("does not call a plugin's hooks for requests in an org where it is not enabled", async () => {
  const calls: string[] = [];
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin(async (ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    ctx.provide("identity", createIdentityService(ctx));
    ctx.provide("authz", createAuthzService(ctx));
    ctx.provide("content", createContentService(ctx));
    ctx.provide("installations", createInstallationsService(ctx));
    ctx.provide("http", createHttpService(ctx));
  });
  const root = fiber.ctx;
  const { content, installations, http } = root;

  const orgA = await content.createOrg({ slug: "org-a", name: "A" });
  const orgB = await content.createOrg({ slug: "org-b", name: "B" });
  await installations.install("acme.analytics");
  await installations.setEnabled(
    "acme.analytics",
    { kind: "org", orgId: orgA.id },
    true,
  );

  await root.plugin(
    definePlugin({
      name: "acme.analytics",
      apply(ctx) {
        ctx.on(PAGE_VIEWED, ((orgId: string) => {
          calls.push(orgId);
        }) as never);
      },
    }),
  );

  http.route(
    "GET",
    "/orgs/:orgId/page",
    async ({ params }) => {
      const orgId = params.orgId ?? "";
      const filter = await installations.scope({ kind: "org", orgId });
      root.emit(filter as never, PAGE_VIEWED, orgId as never);
      return new Response("ok");
    },
    { public: true },
  );

  for (const org of [orgA, orgB]) {
    const response = await http.fetch(
      new Request(`http://localhost/orgs/${org.id}/page`),
    );
    expect(response.status).toBe(200);
  }

  expect(calls).toEqual([orgA.id]);

  // Control: the hook is live, so the missing org B call came from the filter.
  root.emit(PAGE_VIEWED, "unscoped" as never);
  expect(calls).toEqual([orgA.id, "unscoped"]);

  await fiber.dispose();
});
