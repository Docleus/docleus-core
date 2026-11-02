import { Context, type Fiber } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "./storage.ts";

export interface TestInstance {
  readonly ctx: Context;
  dispose(): Promise<void>;
}

/**
 * Creates a root context with a `storage` service already provided, for
 * exercising core plugins and conformance suites without a real
 * deployment. Storage is in-memory SQLite, or a fresh Postgres database
 * when `DOCLEUS_TEST_POSTGRES_URL` is set (see {@link testStorageLocation}).
 * `dispose()` unloads everything registered since.
 */
export async function createTestInstance(): Promise<TestInstance> {
  const location = await testStorageLocation();
  const root = new Context();
  const fiber: Fiber = await root.plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, location));
  });
  return {
    ctx: root,
    dispose: () => fiber.dispose(),
  };
}
