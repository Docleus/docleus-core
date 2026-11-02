import type { InstallationsService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { installationsConformanceSuite } from "./installations.ts";

/** Violates org scoping: one enablement switch shared by every org and space. */
function createBrokenInstallationsService(): InstallationsService {
  const installed = new Set<string>();
  const enabled = new Set<string>();
  return {
    async install(plugin) {
      installed.add(plugin);
    },
    async uninstall(plugin) {
      installed.delete(plugin);
      enabled.delete(plugin);
    },
    async isInstalled(plugin) {
      return installed.has(plugin);
    },
    async listInstalled() {
      return [...installed];
    },
    async setEnabled(plugin, _scope, value) {
      if (value) enabled.add(plugin);
      else enabled.delete(plugin);
    },
    async isEnabled(plugin) {
      return enabled.has(plugin);
    },
    async setSettings() {},
    async getSettings() {
      return undefined;
    },
    async scope() {
      return {
        allows: (plugin: string) =>
          !installed.has(plugin) || enabled.has(plugin),
      };
    },
  };
}

describe("a deliberately broken installations implementation", () => {
  it("fails the org-scoping invariant the suite is meant to catch", async () => {
    const invariant = installationsConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "enabling in an org applies to that org and its spaces only",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve(invariant.check(createBrokenInstallationsService())),
    ).rejects.toThrow();
  });
});
