// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const SDK_BUNDLE = "vendor/docleus-sdk.js";

interface SourceMap {
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
}

let outRoot: string;

async function buildInto(configFile: string, name: string): Promise<string> {
  const outDir = join(outRoot, name);
  await build({
    root: APP_DIR,
    configFile: join(APP_DIR, configFile),
    logLevel: "silent",
    build: { outDir },
  });
  return outDir;
}

async function scripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) =>
      relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    )
    .toSorted();
}

async function readMap(dir: string, file: string): Promise<SourceMap> {
  return JSON.parse(
    await readFile(join(dir, `${file}.map`), "utf8"),
  ) as SourceMap;
}

/** Every `name@version` of an npm package a map's sources come from. */
function packageVersions(map: SourceMap): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  for (const source of map.sources) {
    const match = /\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^/_]+)/.exec(source);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].replace("+", "/");
    versions.set(name, (versions.get(name) ?? new Set()).add(match[2]));
  }
  return versions;
}

beforeAll(async () => {
  outRoot = await mkdtemp(join(tmpdir(), "docleus-app-build-"));
}, 60_000);

afterAll(async () => {
  await rm(outRoot, { recursive: true, force: true });
});

describe.each([
  { configFile: "vite.config.ts", name: "app" },
  { configFile: "vite.site.config.ts", name: "site" },
])("the $name build", ({ configFile, name }) => {
  let dir: string;

  beforeAll(async () => {
    dir = await buildInto(configFile, name);
  }, 60_000);

  it("links every non-empty script to a source map with its sources", async () => {
    const files = await scripts(dir);
    expect(files).toContain(SDK_BUNDLE);
    for (const file of files) {
      const code = await readFile(join(dir, file), "utf8");
      const map = await readMap(dir, file).catch(() => undefined);
      if (!map) {
        // Shims that only re-export another chunk have no code to map.
        expect(code, file).not.toMatch(/sourceMappingURL/);
        expect(code.length, file).toBeLessThan(2048);
        continue;
      }
      const base = file.split("/").at(-1) ?? file;
      expect(code, file).toContain(`//# sourceMappingURL=${base}.map`);
      expect(map.sources.length, file).toBeGreaterThan(0);
      expect(map.sourcesContent?.length, file).toBe(map.sources.length);
    }
  });

  it("bundles one version of each package into the SDK", async () => {
    const files = await scripts(dir);
    const versions = new Map<string, Set<string>>();
    for (const file of files) {
      const map = await readMap(dir, file).catch(() => undefined);
      if (!map) continue;
      for (const [pkg, found] of packageVersions(map)) {
        versions.set(pkg, new Set([...(versions.get(pkg) ?? []), ...found]));
      }
    }
    expect(versions.get("zod")?.size).toBe(1);
    for (const [pkg, found] of versions) {
      expect([...found], pkg).toHaveLength(1);
    }
  });
});
