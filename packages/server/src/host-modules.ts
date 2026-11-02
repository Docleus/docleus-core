import { existsSync, realpathSync } from "node:fs";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DocleusError } from "@docleus/kernel";

/** Packages the host provides to installed plugins' server entries. */
export const HOST_MODULES = ["@docleus/sdk"] as const;

function findPackageDir(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (dirname(dir) === dir) {
      throw new DocleusError(
        "plugin/host-module-missing",
        `cannot find the host module "${name}" from ${from}`,
      );
    }
  }
}

/**
 * Makes the host modules resolvable from every plugin under `pluginsDir`
 * through `<pluginsDir>/node_modules`, so an installed plugin shares the
 * host's single copy of the SDK.
 */
export async function linkHostModules(pluginsDir: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of HOST_MODULES) {
    const target = findPackageDir(name, here);
    const link = join(pluginsDir, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    const current = await readlink(link).catch(() => undefined);
    if (current === target) continue;
    await rm(link, { recursive: true, force: true });
    await symlink(target, link, "dir");
  }
}

/** Removes copies of host modules a plugin ships, so the host's copy is used. */
export async function removeShippedHostModules(dir: string): Promise<void> {
  for (const name of HOST_MODULES) {
    await rm(join(dir, "node_modules", name), { recursive: true, force: true });
  }
}
