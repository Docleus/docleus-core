import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { onTestFinished } from "vitest";

/**
 * Environment variable naming a Postgres server (an admin connection URL,
 * for example `postgres://user:pass@127.0.0.1:5432/postgres`). When set,
 * {@link testStorageLocation} gives every caller a fresh database on it.
 *
 * @stability experimental
 */
export const TEST_POSTGRES_URL_ENV = "DOCLEUS_TEST_POSTGRES_URL";

/**
 * The Postgres admin URL from {@link TEST_POSTGRES_URL_ENV}, or `undefined`
 * when tests run on SQLite only. Use it for `describe.skipIf` on
 * Postgres-only tests.
 *
 * @stability experimental
 */
export function testPostgresUrl(): string | undefined {
  const url = process.env[TEST_POSTGRES_URL_ENV];
  return url === undefined || url === "" ? undefined : url;
}

/**
 * The dialect {@link testStorageLocation} selects in this run.
 *
 * @stability experimental
 */
export function testStorageDialect(): "sqlite" | "postgres" {
  return testPostgresUrl() === undefined ? "sqlite" : "postgres";
}

async function withAdmin<T>(
  adminUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates an empty Postgres database on the server at `adminUrl` and
 * returns its URL and a function that drops it (terminating any
 * connections still open to it).
 *
 * @stability experimental
 */
export async function createTestPostgresDatabase(
  adminUrl: string,
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `docleus_test_${randomBytes(6).toString("hex")}`;
  await withAdmin(adminUrl, (client) =>
    client.query(`create database ${name}`),
  );
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      await withAdmin(adminUrl, (client) =>
        client.query(`drop database if exists ${name} with (force)`),
      );
    },
  };
}

/**
 * Database location for one test, to pass to `createStorageService` or
 * `createInstance({ database })`: `undefined` (in-memory SQLite) normally,
 * or the URL of a fresh Postgres database when
 * {@link TEST_POSTGRES_URL_ENV} is set. The database is dropped when the
 * current test finishes, after its `afterEach` hooks, so call this inside
 * a test or a `beforeEach` hook.
 *
 * @stability experimental
 */
export async function testStorageLocation(): Promise<string | undefined> {
  const adminUrl = testPostgresUrl();
  if (adminUrl === undefined) return undefined;
  const database = await createTestPostgresDatabase(adminUrl);
  onTestFinished(() => database.drop());
  return database.url;
}
