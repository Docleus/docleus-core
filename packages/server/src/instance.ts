import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Context, type ConfigRow, type Fiber } from "@docleus/kernel";
import {
  DEFAULT_SITE_CACHE_MAX_BYTES,
  createSitesService,
} from "@docleus/core-sites";
import { registerAuthApi } from "./api/auth.ts";
import { registerContentApi } from "./api/content.ts";
import { registerDevIdentity } from "./api/dev-identity.ts";
import { registerMembersApi } from "./api/members.ts";
import { registerPluginAdminApi } from "./api/plugin-admin.ts";
import { registerPluginApi } from "./api/plugins.ts";
import { createSerializer } from "./api/serial.ts";
import { registerSitesApi } from "./api/sites.ts";
import { prepareBoot } from "./backup.ts";
import { registerBlobCollector } from "./blob-gc.ts";
import { resolveBlobSecret } from "./blob-secret.ts";
import { mountCoreProviders } from "./core-providers.ts";
import { readDeploymentConfig, type Role } from "./deployment-config.ts";
import { registerDeletedScopeGrants } from "./deleted-scope-grants.ts";
import {
  createFrontend,
  type Frontend,
  type MountedPlugin,
} from "./frontend.ts";
import { PluginHost } from "./host.ts";
import { linkHostModules } from "./host-modules.ts";
import type { Mailer } from "./mailer.ts";
import { composePluginRows, createPluginManager } from "./plugin-manager.ts";
import {
  PLATFORM_VERSION,
  createLocalManifestReader,
  createLocalResolver,
  resolvePluginDir,
} from "./resolve-plugin.ts";
import { serveSites } from "./serve-sites.ts";
import { createSiteAssetSource } from "./site-assets.ts";
import { runJobLoop } from "./worker.ts";

export interface InstanceOptions {
  /** Directory for the database and blobs; in-memory storage and a temporary blob directory when omitted. */
  dataDir?: string;
  /** Database location: a `postgres://` URL or a SQLite file path; `<dataDir>/docleus.db` (or in-memory) when omitted. */
  database?: string;
  /** Plugin rows, resolved from `baseDir`. */
  plugins?: readonly ConfigRow[];
  baseDir?: string;
  /** The deployment config file: its plugin rows patch `plugins`, and runtime installs are recorded in it. */
  configFile?: string;
  /** `web` serves requests without running jobs; `worker` runs jobs and registers no HTTP routes; `all` (the default) does both. */
  role?: Role;
  /** The built `@docleus/app` directory, served under `/_app/`. */
  appDir?: string;
  /** The built site runtime (`@docleus/app`'s `dist-site`), copied into every published site. */
  siteRuntimeDir?: string;
  /** Enables the development identity provider. Never use in production. */
  isDev?: boolean;
  /** The URL users reach the instance at, for links in invitations; the request's origin when omitted. */
  publicUrl?: string;
  /**
   * Signs blob URLs, at least 32 characters; processes that serve the same
   * blobs need the same one. When omitted, a secret generated once and kept
   * in `<dataDir>/blob-secret` (random per boot without a data directory).
   */
  blobSecret?: string;
  /** Trusts `X-Forwarded-Proto` and `X-Forwarded-For` from a reverse proxy. */
  trustProxy?: boolean;
  /** Sends invitation emails; invitations are only shown as links when omitted. */
  mailer?: Mailer;
  /** The clock for sign-in rate limits; `Date.now` when omitted. */
  now?: () => number;
}

export interface InstanceFetchInfo {
  /** The client's IP address, for sign-in rate limits. */
  readonly clientAddress?: string;
}

export interface Instance {
  readonly ctx: Context;
  readonly plugins: ReadonlyMap<string, MountedPlugin>;
  /** The one-time token `/setup` asks for, while the instance has no users. */
  readonly setupToken: string | undefined;
  fetch(request: Request, info?: InstanceFetchInfo): Promise<Response>;
  /** Serves an upgrade request (such as a WebSocket) the server received on `socket`. Site domains never upgrade. */
  upgrade(
    request: Request,
    raw: {
      readonly incoming: IncomingMessage;
      readonly socket: Duplex;
      readonly head: Buffer;
    },
    info?: InstanceFetchInfo,
  ): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Boots an instance: the core services on a root context, the instance API,
 * the configured plugins (installed on first boot), and the frontend.
 * Resolves after the dependent sites service and instance API initialize.
 */
export async function createInstance(
  options: InstanceOptions = {},
): Promise<Instance> {
  return bootInstance(options, {});
}

interface BootMode {
  /** Boots for `docleus migrate`: no HTTP and no job loop. */
  readonly isMigrating?: boolean;
  readonly onMigrate?: (task: Promise<void>) => void;
}

/** What {@link migrateInstance} did. */
export interface MigrateResult {
  /** The spaces whose bodies were committed at current block versions. */
  readonly migratedSpaces: readonly string[];
}

/**
 * `docleus migrate`: boots the instance without serving HTTP or running
 * jobs, which backs up SQLite and runs every platform and plugin storage
 * migration, then commits every space with its bodies at current block
 * versions (`content.migrate`), and shuts down. Rejects when a migration
 * fails.
 */
export async function migrateInstance(
  options: Omit<InstanceOptions, "role"> = {},
): Promise<MigrateResult> {
  const tasks: Promise<void>[] = [];
  const instance = await bootInstance(options, {
    isMigrating: true,
    onMigrate: (task) => tasks.push(task),
  });
  try {
    // Waiting on one migration can start others (a plugin that migrates
    // once a service is ready), so wait until no new ones appear.
    for (let done = 0; done < tasks.length;) {
      const batch = tasks.slice(done);
      done = tasks.length;
      await Promise.all(batch);
    }
    const { content } = instance.ctx;
    const migratedSpaces: string[] = [];
    for (const org of await content.listOrgs()) {
      for (const space of await content.listSpaces(org.id)) {
        if (await content.migrate(space.id)) migratedSpaces.push(space.id);
      }
    }
    return { migratedSpaces };
  } finally {
    await instance.dispose();
  }
}

async function bootInstance(
  options: InstanceOptions,
  mode: BootMode,
): Promise<Instance> {
  const baseDir = options.baseDir ?? process.cwd();
  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const blobSecret = await resolveBlobSecret(
    options.blobSecret,
    options.dataDir,
  );

  const plugins = new Map<string, MountedPlugin>();
  const readManifest = createLocalManifestReader(baseDir);
  const deploymentConfig = options.configFile
    ? readDeploymentConfig(options.configFile)
    : undefined;
  const deployment = deploymentConfig?.plugins ?? [];
  const rows = composePluginRows(
    options.plugins ?? [],
    deployment,
    options.configFile,
  ).filter((row) => !row.disabled);
  for (const row of rows) {
    const manifest = readManifest(row.plugin);
    plugins.set(manifest.name, {
      manifest,
      dir: resolvePluginDir(baseDir, row.plugin),
    });
  }
  // A configured plugin whose manifest provides a core key replaces the core
  // provider; services that use the key inject it, so they wait for the plugin.
  const pluginProvided = new Set(
    [...plugins.values()].flatMap(({ manifest }) => manifest.provides),
  );

  const pluginsDir = options.dataDir
    ? join(options.dataDir, "plugins")
    : mkdtempSync(join(tmpdir(), "docleus-plugins-"));
  await linkHostModules(pluginsDir);
  const boot = await prepareBoot({
    dataDir: options.dataDir,
    database: options.database,
    plugins: [...plugins.values()].map(({ manifest }) => manifest),
    platform: PLATFORM_VERSION,
  });

  // A worker serves no HTTP: its `ctx.http` keeps no routes, and it needs
  // no setup token.
  const isServing = options.role !== "worker" && !mode.isMigrating;
  const root = new Context();
  if (boot.backup) root.logger("server").info("backed up to %s", boot.backup);
  const core = await mountCoreProviders(root, pluginProvided, {
    database:
      options.database ??
      (options.dataDir ? join(options.dataDir, "docleus.db") : undefined),
    ...(options.dataDir && { blobsDir: join(options.dataDir, "blobs") }),
    blobSecret,
    trustProxy: options.trustProxy === true,
    isServing,
    ...(mode.onMigrate && { onMigrate: mode.onMigrate }),
  });
  const sites: Fiber = await root.plugin({
    name: "@docleus/server/sites",
    inject: ["storage", "blobs", "content", "installations", "render"],
    apply(ctx: Context) {
      ctx.provide(
        "sites",
        createSitesService(ctx, {
          platformVersion: PLATFORM_VERSION,
          assets: createSiteAssetSource({
            runtimeDir: options.siteRuntimeDir,
            plugins,
          }),
          ...(options.dataDir && {
            cache: {
              dir: join(options.dataDir, "cache", "blobs"),
              maxBytes:
                deploymentConfig?.siteCache?.maxBytes ??
                DEFAULT_SITE_CACHE_MAX_BYTES,
            },
          }),
        }),
      );
    },
  });

  const frontend: Frontend = createFrontend({
    plugins,
    ...(options.appDir && { appDir: options.appDir }),
  });
  const setupToken =
    isServing && !options.isDev && (await root.identity.countUsers()) === 0
      ? randomBytes(18).toString("base64url")
      : undefined;
  const api: Fiber = await root.plugin({
    name: "@docleus/server/api",
    inject: [
      "storage",
      "http",
      "identity",
      "authz",
      "content",
      "installations",
      "sites",
    ],
    async apply(ctx: Context) {
      await registerDeletedScopeGrants(ctx);
      const serial = createSerializer();
      registerAuthApi(ctx, {
        isDev: options.isDev === true,
        setupToken,
        publicUrl: options.publicUrl,
        now: options.now ?? Date.now,
        serial,
      });
      registerContentApi(ctx);
      registerMembersApi(ctx, {
        serial,
        publicUrl: options.publicUrl,
        trustProxy: options.trustProxy,
        mailer: options.mailer,
      });
      registerPluginApi(ctx, { plugins, frontend });
      registerSitesApi(ctx);
      if (options.isDev) registerDevIdentity(ctx);
    },
  });

  const host = new PluginHost(root, createLocalResolver(baseDir), {
    manifest: readManifest,
  });
  await host.apply(rows);
  for (const name of plugins.keys()) await root.installations.install(name);
  await sites.await();
  await api.await();
  await boot.finish();
  const manager = createPluginManager({
    ctx: root,
    host,
    plugins,
    frontend,
    core,
    baseDir,
    bundle: options.plugins ?? [],
    deployment,
    ...(options.configFile && { configFile: options.configFile }),
    pluginsDir,
  });
  const admin: Fiber = await root.plugin({
    name: "@docleus/server/plugin-admin",
    inject: ["http", "installations", "jobs"],
    apply(ctx: Context) {
      registerPluginAdminApi(ctx, manager);
      if (options.role !== "web" && !mode.isMigrating) runJobLoop(ctx);
    },
  });

  // Injects `sites` so that collection pauses while the core marker of
  // site artifacts is not mounted.
  const blobCollector: Fiber | undefined =
    options.role === "web" || mode.isMigrating
      ? undefined
      : await root.plugin({
          name: "@docleus/server/blob-gc",
          inject: ["storage", "blobs", "jobs", "sites"],
          apply: (ctx: Context) => registerBlobCollector(ctx),
        });

  return {
    ctx: root,
    plugins,
    setupToken,
    async fetch(request, info = {}) {
      const site = await serveSites(root, request);
      if (site) return site;
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) return root.http.fetch(request, info);
      return frontend.serve(request);
    },
    async upgrade(request, raw, info = {}) {
      const domain = request.headers.get("host") ?? new URL(request.url).host;
      if (await root.sites.findByDomain(domain)) {
        raw.socket.end(
          "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      await root.http.handleUpgrade(request, raw, info);
    },
    async dispose() {
      await blobCollector?.dispose();
      await admin.dispose();
      await host.apply([]);
      await api.dispose();
      await sites.dispose();
      await core.dispose();
    },
  };
}
