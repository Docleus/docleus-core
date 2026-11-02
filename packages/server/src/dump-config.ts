import { readFileSync, existsSync } from "node:fs";
import {
  dumpConfig,
  composeConfig,
  parseBundle,
  parsePatch,
  type ConfigRow,
} from "@docleus/kernel";

export interface DumpConfigArgs {
  bundle: string;
  profile?: string;
  deployment?: string;
  patches?: string[];
}

const read = (path: string) => readFileSync(path, "utf8");

export function dumpResolvedConfig(args: DumpConfigArgs): string {
  const rows = composeConfig({
    bundle: parseBundle(args.bundle, read(args.bundle)),
    profile:
      args.profile && existsSync(args.profile)
        ? parsePatch(args.profile, read(args.profile))
        : [],
    deployment:
      args.deployment && existsSync(args.deployment)
        ? parsePatch(args.deployment, read(args.deployment))
        : [],
    overlays: (args.patches ?? []).map((path) => parsePatch(path, read(path))),
  });
  return dumpConfig(rows);
}

/**
 * The plugin rows of a bundle file, without the core services an instance
 * always provides. Disabled rows are kept so that a deployment config can
 * enable them; the instance skips them otherwise.
 */
export function readBundlePlugins(bundle: string): ConfigRow[] {
  return composeConfig({ bundle: parseBundle(bundle, read(bundle)) }).filter(
    (row) => !row.plugin.startsWith("@docleus/core-"),
  );
}
