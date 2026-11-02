import { fileURLToPath } from "node:url";
import { Context, DocleusError, type ConfigRow } from "@docleus/kernel";
import { describe, expect, it, vi } from "vitest";
import {
  PluginHost,
  createLocalManifestReader,
  createLocalResolver,
} from "../src/index.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const resolver = createLocalResolver(fixtures);

const provider: ConfigRow = {
  id: "hello",
  plugin: "provider",
  config: { who: "docleus" },
};
const consumer: ConfigRow = { id: "greeter", plugin: "consumer" };

const listeners = (root: Context): number =>
  root.events["_hooks"]["test/fixture"]?.length ?? 0;

async function consumerSaid(): Promise<string[]> {
  const module = (await import(`${fixtures}consumer/index.js`)) as {
    said: string[];
  };
  return module.said;
}

describe("PluginHost", () => {
  it("loads plugins from local paths and activates the consumer after its provider", async () => {
    const said = await consumerSaid();
    said.length = 0;
    const root = new Context();
    const host = new PluginHost(root, resolver);

    await host.apply([consumer, provider]);

    await vi.waitFor(() => expect(said).toEqual(["hello docleus"]));
    expect(host.ids).toEqual(["greeter", "hello"]);
  });

  it("adds and removes plugins on config change without restarting", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver);

    await host.apply([provider]);
    expect(listeners(root)).toBe(1);

    await host.apply([provider, consumer]);
    await vi.waitFor(() => expect(listeners(root)).toBe(2));

    await host.apply([]);
    expect(listeners(root)).toBe(0);
    expect(root.get("test.hello")).toBeUndefined();
    expect(root.registry.size).toBe(0);
  });

  it("serializes overlapping apply calls so a plugin is mounted once", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver);

    await Promise.all([host.apply([provider]), host.apply([provider])]);

    expect(listeners(root)).toBe(1);
    expect(host.ids).toEqual(["hello"]);
    await host.apply([]);
    expect(listeners(root)).toBe(0);
  });

  it("rejects plugins that claim the same syntax before mounting either", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver, {
      manifest: createLocalManifestReader(fixtures),
    });

    await expect(
      host.apply([
        { id: "a", plugin: "syntax-a" },
        { id: "b", plugin: "syntax-b" },
      ]),
    ).rejects.toMatchObject({ code: "plugin/syntax-conflict" });
    expect(host.ids).toEqual([]);

    await host.apply([{ id: "a", plugin: "syntax-a" }]);
    expect(host.ids).toEqual(["a"]);
  });

  it("rejects plugins that expose the same browser module before mounting either", async () => {
    const host = new PluginHost(new Context(), resolver, {
      manifest: createLocalManifestReader(fixtures),
    });

    await expect(
      host.apply([
        { id: "a", plugin: "expose-a" },
        { id: "b", plugin: "expose-b" },
      ]),
    ).rejects.toMatchObject({ code: "plugin/expose-conflict" });
    expect(host.ids).toEqual([]);
  });

  it("mounts a plugin without a server entry under its manifest name", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver);

    await host.apply([{ id: "e", plugin: "editor-only" }]);

    expect(host.ids).toEqual(["e"]);
    expect([...root.registry.values()].map((fiber) => fiber.name)).toContain(
      "@test/editor-only",
    );
  });

  it("treats a disabled row as absent", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver);

    await host.apply([provider]);
    await host.apply([{ ...provider, disabled: true }]);

    expect(host.ids).toEqual([]);
    expect(listeners(root)).toBe(0);
  });

  it("reloads a plugin when only its config changes", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver);
    await host.apply([provider]);
    expect(root.get("test.hello")?.say()).toBe("hello docleus");

    await host.apply([{ ...provider, config: { who: "again" } }]);

    expect(root.get("test.hello")?.say()).toBe("hello again");
    expect(listeners(root)).toBe(1);
  });

  it("replaces the plugin when a row id points at a different plugin", async () => {
    const root = new Context();
    const host = new PluginHost(root, resolver);
    await host.apply([{ id: "x", plugin: "provider" }]);
    expect(root.get("test.hello")).toBeDefined();

    await host.apply([{ id: "x", plugin: "consumer" }]);

    expect(root.get("test.hello")).toBeUndefined();
  });

  it("rejects an incompatible plugin with a stable error code", async () => {
    const host = new PluginHost(new Context(), resolver);
    const error = await host
      .apply([{ id: "n", plugin: "too-new" }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocleusError);
    expect((error as DocleusError).code).toBe("plugin/load-failed");
    expect(((error as DocleusError).cause as DocleusError).code).toBe(
      "plugin/engines-mismatch",
    );
  });

  it("rejects a missing plugin directory", async () => {
    const host = new PluginHost(new Context(), resolver);
    await expect(
      host.apply([{ id: "m", plugin: "nope" }]),
    ).rejects.toMatchObject({
      code: "plugin/load-failed",
    });
  });
});
