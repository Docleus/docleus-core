import { dirname, join, resolve } from "node:path";
import {
  checkBlobSecret,
  DEPLOYMENT_CONFIG_FILE,
  readBundlePlugins,
  readDeploymentConfig,
  resolveConfigPath,
  type DeploymentConfig,
} from "@docleus/server";

/** The flags `serve` and `migrate` share. */
export interface DeploymentFlags {
  readonly config?: string | undefined;
  readonly data?: string | undefined;
  readonly database?: string | undefined;
  readonly bundle?: string | undefined;
}

/** Where an instance's config, data, database and plugins come from. */
export interface Deployment {
  readonly config: DeploymentConfig;
  readonly configFile: string;
  readonly dataDir: string;
  readonly database: string | undefined;
  readonly plugins: ReturnType<typeof readBundlePlugins>;
  readonly baseDir: string;
  /** Signs blob URLs: `DOCLEUS_BLOB_SECRET`. Like other secrets, never read from the config file. */
  readonly blobSecret: string | undefined;
  /** Resolves a path written in the config file. */
  fromConfig(path: string | undefined): string | undefined;
}

/** A URL stays as written; a SQLite path resolves against the config file. */
function databaseLocation(configFile: string, location: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location)
    ? location
    : resolveConfigPath(configFile, location);
}

/**
 * Reads the deployment config (`--config`, else `<data>/docleus.yaml`) and
 * resolves what the flags leave open from it, then from the environment.
 * Throws when the config file or `DOCLEUS_BLOB_SECRET` is invalid.
 */
export function resolveDeployment(
  flags: DeploymentFlags,
  env: Readonly<Record<string, string | undefined>>,
): Deployment {
  const configFile = flags.config
    ? resolve(flags.config)
    : join(resolve(flags.data ?? ".docleus"), DEPLOYMENT_CONFIG_FILE);
  const config = readDeploymentConfig(configFile);
  const fromConfig = (path: string | undefined) =>
    path === undefined ? undefined : resolveConfigPath(configFile, path);
  const dataDir = flags.data
    ? resolve(flags.data)
    : (fromConfig(config.data) ?? resolve(".docleus"));
  const bundle = flags.bundle
    ? resolve(flags.bundle)
    : fromConfig(config.bundle);
  const blobSecret = env["DOCLEUS_BLOB_SECRET"] || undefined;
  if (blobSecret !== undefined)
    checkBlobSecret(blobSecret, "DOCLEUS_BLOB_SECRET");
  const database =
    flags.database ??
    (config.database && databaseLocation(configFile, config.database)) ??
    (env["DOCLEUS_DATABASE_URL"] || undefined);
  return {
    config,
    configFile,
    dataDir,
    database,
    plugins: bundle ? readBundlePlugins(bundle) : [],
    baseDir: bundle ? dirname(bundle) : process.cwd(),
    blobSecret,
    fromConfig,
  };
}
