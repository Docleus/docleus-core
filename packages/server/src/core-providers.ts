import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Fiber } from "@docleus/kernel";
import type { HttpService, Migration, StorageService } from "@docleus/sdk";
import { createAuthzService } from "@docleus/core-authz";
import { createBlobsService } from "@docleus/core-blobs";
import { createBlocksService } from "@docleus/core-blocks";
import { createContentService } from "@docleus/core-content";
import { createHttpService } from "@docleus/core-http";
import { createIdentityService } from "@docleus/core-identity";
import { createInstallationsService } from "@docleus/core-installations";
import { createJobsService } from "@docleus/core-jobs";
import { createMarkdownService } from "@docleus/core-markdown";
import { createRenderService } from "@docleus/core-render";
import { createStorageService } from "@docleus/core-storage";

export interface CoreProviderOptions {
  /** A `postgres://` URL or a SQLite file path; in-memory when omitted. */
  readonly database?: string;
  /** The local blob directory; a temporary directory when omitted. */
  readonly blobsDir?: string;
  /** Signs blob URLs; random per process when omitted. */
  readonly blobSecret?: Buffer;
  readonly trustProxy?: boolean;
  /**
   * `false` in the `worker` role, which serves no HTTP: `ctx.http` then
   * registers no routes or upgrade handlers, and answers every request 404.
   */
  readonly isServing?: boolean;
  /** Called with every `storage.migrate()` call, so the server can wait for all of them. */
  readonly onMigrate?: (task: Promise<void>) => void;
}

/** An `http` service that keeps nothing it is given, for a process without a listener. */
function inertHttp(http: HttpService): HttpService {
  return {
    route: () => () => undefined,
    upgrade: () => () => undefined,
    routes: () => [],
    fetch: (request, info) => http.fetch(request, info),
    handleUpgrade: (request, raw, info) =>
      http.handleUpgrade(request, raw, info),
    sessionCookie: (request, token) => http.sessionCookie(request, token),
  };
}

/**
 * The core providers, one fiber per ctx key, so that a plugin whose
 * manifest `provides` a key can replace its provider at runtime: services
 * and plugins that inject the key restart on the new provider.
 */
export interface CoreProviders {
  /**
   * Unmounts the core provider of every key in `provided` and mounts the
   * provider of every other core key again. Call it before mounting a
   * plugin that provides a key, and after unmounting one.
   */
  sync(provided: Iterable<string>): Promise<void>;
  dispose(): Promise<void>;
}

interface CoreProvider {
  readonly key: string;
  readonly inject: readonly string[];
  create(ctx: Context): unknown;
}

function providers(options: CoreProviderOptions): CoreProvider[] {
  let blobsDir = options.blobsDir;
  return [
    {
      key: "storage",
      inject: [],
      create: (ctx) => {
        const storage = createStorageService(ctx, options.database);
        const { onMigrate } = options;
        if (!onMigrate) return storage;
        return {
          ...storage,
          migrate(owner: string, migrations: readonly Migration[]) {
            const task = storage.migrate(owner, migrations);
            onMigrate(task);
            return task;
          },
        } satisfies StorageService;
      },
    },
    {
      key: "blobs",
      inject: [],
      create: () => {
        blobsDir ??= mkdtempSync(join(tmpdir(), "docleus-blobs-"));
        return createBlobsService(blobsDir, options.blobSecret);
      },
    },
    {
      key: "identity",
      inject: ["storage"],
      create: (ctx) => createIdentityService(ctx),
    },
    {
      key: "authz",
      inject: ["storage", "identity"],
      create: (ctx) => createAuthzService(ctx),
    },
    {
      key: "installations",
      inject: ["storage"],
      create: (ctx) => createInstallationsService(ctx),
    },
    { key: "blocks", inject: [], create: (ctx) => createBlocksService(ctx) },
    {
      key: "content",
      inject: ["storage", "blocks"],
      create: (ctx) => createContentService(ctx),
    },
    {
      key: "markdown",
      inject: [],
      create: (ctx) => createMarkdownService(ctx),
    },
    { key: "render", inject: [], create: (ctx) => createRenderService(ctx) },
    {
      key: "jobs",
      inject: ["storage"],
      create: (ctx) => createJobsService(ctx),
    },
    {
      key: "http",
      inject: ["authz", "identity"],
      create: (ctx) => {
        const http = createHttpService(ctx, {
          trustProxy: options.trustProxy === true,
        });
        return options.isServing === false ? inertHttp(http) : http;
      },
    },
  ];
}

/** Mounts the core provider of every core key not in `provided`. */
export async function mountCoreProviders(
  root: Context,
  provided: Iterable<string>,
  options: CoreProviderOptions = {},
): Promise<CoreProviders> {
  const all = providers(options);
  const fibers = new Map<string, Fiber>();

  async function mount(provider: CoreProvider): Promise<void> {
    const fiber = root.plugin({
      name: `@docleus/server/core/${provider.key}`,
      inject: [...provider.inject],
      apply(ctx: Context) {
        ctx.provide(provider.key, provider.create(ctx));
      },
    });
    fibers.set(provider.key, fiber);
    await fiber;
  }

  async function sync(keys: Iterable<string>): Promise<void> {
    const wanted = new Set(keys);
    for (const provider of all.toReversed()) {
      const fiber = fibers.get(provider.key);
      if (!fiber || !wanted.has(provider.key)) continue;
      fibers.delete(provider.key);
      await fiber.dispose();
    }
    for (const provider of all) {
      if (wanted.has(provider.key) || fibers.has(provider.key)) continue;
      await mount(provider);
    }
  }

  await sync(provided);
  return {
    sync,
    async dispose() {
      for (const provider of all.toReversed()) {
        const fiber = fibers.get(provider.key);
        fibers.delete(provider.key);
        await fiber?.dispose();
      }
    },
  };
}
