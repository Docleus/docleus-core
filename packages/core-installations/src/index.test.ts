import { Context, type Fiber } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import {
  installationsConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import type { InstallationsService } from "@docleus/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createInstallationsService } from "./index.ts";

const fibers: Fiber[] = [];

async function freshInstallations(): Promise<InstallationsService> {
  let installations!: InstallationsService;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    installations = createInstallationsService(ctx);
  });
  fibers.push(fiber);
  return installations;
}

runConformanceSuite(installationsConformanceSuite, freshInstallations);

afterEach(async () => {
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

describe("createInstallationsService", () => {
  it("treats an installed plugin as enabled at instance scope", async () => {
    const installations = await freshInstallations();
    await installations.install("acme.plugin");
    expect(
      await installations.isEnabled("acme.plugin", { kind: "instance" }),
    ).toBe(true);
  });

  it("reports scope errors with stable codes", async () => {
    const installations = await freshInstallations();
    await expect(
      installations.setEnabled(
        "acme.plugin",
        { kind: "org", orgId: "a" },
        true,
      ),
    ).rejects.toMatchObject({ code: "installations/not-installed" });
    await installations.install("acme.plugin");
    await expect(
      installations.setEnabled("acme.plugin", { kind: "instance" }, true),
    ).rejects.toMatchObject({ code: "installations/instance-scope" });
  });

  it("clears settings when given undefined", async () => {
    const installations = await freshInstallations();
    const org = { kind: "org", orgId: "a" } as const;
    await installations.install("acme.plugin");
    await installations.setSettings("acme.plugin", org, { a: 1 });
    await installations.setSettings("acme.plugin", org, undefined);
    expect(await installations.getSettings("acme.plugin", org)).toBeUndefined();
  });
});
