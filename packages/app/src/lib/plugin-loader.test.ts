import { Context, definePlugin } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createPluginLoader } from "./plugin-loader.ts";

function fakeModules() {
  const active = new Set<string>();
  const modules = new Map(
    ["a", "b", "c"].map((name) => [
      `/${name}.js`,
      {
        plugin: definePlugin({
          name,
          apply(ctx) {
            ctx.effect(() => {
              active.add(name);
              return () => active.delete(name);
            });
          },
        }),
      },
    ]),
  );
  return { active, importModule: async (url: string) => modules.get(url) };
}

const entry = (name: string) => ({ name, url: `/${name}.js` });

describe("createPluginLoader", () => {
  it("mounts new entries and unloads the ones that left", async () => {
    const { active, importModule } = fakeModules();
    const loader = createPluginLoader(new Context(), importModule);

    await loader.apply([entry("a"), entry("b")]);
    expect([...active].toSorted()).toEqual(["a", "b"]);

    await loader.apply([entry("b"), entry("c")]);
    expect([...active].toSorted()).toEqual(["b", "c"]);
    expect(loader.urls.toSorted()).toEqual(["/b.js", "/c.js"]);

    await loader.apply([]);
    expect(active.size).toBe(0);
  });

  it("serializes overlapping calls", async () => {
    const { active, importModule } = fakeModules();
    const loader = createPluginLoader(new Context(), importModule);
    await Promise.all([loader.apply([entry("a")]), loader.apply([entry("a")])]);
    expect(loader.urls).toEqual(["/a.js"]);
    expect([...active]).toEqual(["a"]);
  });

  it("rejects a module without a plugin export", async () => {
    const loader = createPluginLoader(new Context(), async () => ({}));
    await expect(loader.apply([entry("a")])).rejects.toMatchObject({
      code: "plugin/no-plugin-export",
    });
  });
});
