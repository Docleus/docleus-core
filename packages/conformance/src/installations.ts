import type { InstallationsService, Scope } from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

const PLUGIN = "acme.plugin";
const INSTANCE: Scope = { kind: "instance" };
const ORG_A: Scope = { kind: "org", orgId: "org-a" };
const ORG_B: Scope = { kind: "org", orgId: "org-b" };
const SPACE_A1: Scope = { kind: "space", orgId: "org-a", spaceId: "space-1" };
const SPACE_A2: Scope = { kind: "space", orgId: "org-a", spaceId: "space-2" };

export const installationsConformanceSuite =
  defineConformanceSuite<InstallationsService>("installations", [
    {
      name: "install is idempotent and uninstall removes the plugin",
      async check(installations) {
        await installations.install(PLUGIN);
        await installations.install(PLUGIN);
        expect(await installations.listInstalled()).toEqual([PLUGIN]);
        expect(await installations.isInstalled(PLUGIN)).toBe(true);
        await installations.uninstall(PLUGIN);
        expect(await installations.isInstalled(PLUGIN)).toBe(false);
        expect(await installations.listInstalled()).toEqual([]);
      },
    },
    {
      name: "an installed plugin is disabled in orgs and spaces until enabled",
      async check(installations) {
        await installations.install(PLUGIN);
        expect(await installations.isEnabled(PLUGIN, ORG_A)).toBe(false);
        expect(await installations.isEnabled(PLUGIN, SPACE_A1)).toBe(false);
      },
    },
    {
      name: "enabling in an org applies to that org and its spaces only",
      async check(installations) {
        await installations.install(PLUGIN);
        await installations.setEnabled(PLUGIN, ORG_A, true);
        expect(await installations.isEnabled(PLUGIN, ORG_A)).toBe(true);
        expect(await installations.isEnabled(PLUGIN, SPACE_A1)).toBe(true);
        expect(await installations.isEnabled(PLUGIN, ORG_B)).toBe(false);
      },
    },
    {
      name: "a space override wins over its org, and clearing it inherits again",
      async check(installations) {
        await installations.install(PLUGIN);
        await installations.setEnabled(PLUGIN, ORG_A, true);
        await installations.setEnabled(PLUGIN, SPACE_A1, false);
        expect(await installations.isEnabled(PLUGIN, SPACE_A1)).toBe(false);
        expect(await installations.isEnabled(PLUGIN, SPACE_A2)).toBe(true);
        await installations.setEnabled(PLUGIN, SPACE_A1, undefined);
        expect(await installations.isEnabled(PLUGIN, SPACE_A1)).toBe(true);
      },
    },
    {
      name: "a plugin that is not installed is never enabled and cannot be configured",
      async check(installations) {
        expect(await installations.isEnabled(PLUGIN, ORG_A)).toBe(false);
        await expectToReject(() =>
          installations.setEnabled(PLUGIN, ORG_A, true),
        );
        await expectToReject(() =>
          installations.setSettings(PLUGIN, ORG_A, { a: 1 }),
        );
      },
    },
    {
      name: "enablement and settings are rejected at instance scope",
      async check(installations) {
        await installations.install(PLUGIN);
        await expectToReject(() =>
          installations.setEnabled(PLUGIN, INSTANCE, true),
        );
        await expectToReject(() =>
          installations.setSettings(PLUGIN, INSTANCE, { a: 1 }),
        );
      },
    },
    {
      name: "settings resolve from the nearest scope that defines them",
      async check(installations) {
        await installations.install(PLUGIN);
        await installations.setSettings(PLUGIN, ORG_A, { color: "red" });
        await installations.setSettings(PLUGIN, SPACE_A1, { color: "blue" });
        expect(await installations.getSettings(PLUGIN, SPACE_A1)).toEqual({
          color: "blue",
        });
        expect(await installations.getSettings(PLUGIN, SPACE_A2)).toEqual({
          color: "red",
        });
        expect(await installations.getSettings(PLUGIN, ORG_B)).toBeUndefined();
      },
    },
    {
      name: "uninstalling removes enablement and settings, so reinstalling starts clean",
      async check(installations) {
        await installations.install(PLUGIN);
        await installations.setEnabled(PLUGIN, ORG_A, true);
        await installations.setSettings(PLUGIN, ORG_A, { a: 1 });
        await installations.uninstall(PLUGIN);
        await installations.install(PLUGIN);
        expect(await installations.isEnabled(PLUGIN, ORG_A)).toBe(false);
        expect(await installations.getSettings(PLUGIN, ORG_A)).toBeUndefined();
      },
    },
    {
      name: "a dispatch scope allows enabled and uninstalled plugins and blocks disabled ones",
      async check(installations) {
        await installations.install(PLUGIN);
        await installations.install("acme.other");
        await installations.setEnabled(PLUGIN, ORG_A, true);
        const inA = await installations.scope(ORG_A);
        expect(inA.allows(PLUGIN)).toBe(true);
        expect(inA.allows("acme.other")).toBe(false);
        expect(inA.allows("not-installed")).toBe(true);
        const inB = await installations.scope(ORG_B);
        expect(inB.allows(PLUGIN)).toBe(false);
      },
    },
  ]);
