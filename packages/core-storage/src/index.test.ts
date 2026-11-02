import { randomBytes } from "node:crypto";
import { Context, type Fiber } from "@docleus/kernel";
import { sql, type Kysely } from "kysely";
import { Client } from "pg";
import {
  runConformanceSuite,
  storageConformanceSuite,
} from "@docleus/conformance";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { createStorageService, type StorageService } from "./index.ts";

// core-storage cannot use `@docleus/testing` (which depends on it), so it
// creates its per-test Postgres databases itself.
const POSTGRES_URL = process.env.DOCLEUS_TEST_POSTGRES_URL || undefined;

async function admin(query: string): Promise<void> {
  const client = new Client({ connectionString: POSTGRES_URL });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

async function freshPostgresUrl(): Promise<string> {
  if (POSTGRES_URL === undefined) throw new Error("no postgres server");
  const name = `docleus_test_${randomBytes(6).toString("hex")}`;
  await admin(`create database ${name}`);
  onTestFinished(() => admin(`drop database if exists ${name} with (force)`));
  const url = new URL(POSTGRES_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

// `createStorageService` disposes its connection through `ctx.effect()`,
// which only runs on a plugin fiber's unload; a root context's own fiber
// cannot be disposed (`fiber.dispose()` on root restarts instead). Every
// test here creates the service inside a child plugin so disposal is
// actually exercised and connections are not leaked across tests.
const fibers: Fiber[] = [];

async function open(location?: string): Promise<StorageService> {
  let storage!: StorageService;
  const fiber = await new Context().plugin((ctx: Context) => {
    storage = createStorageService(ctx, location);
  });
  fibers.push(fiber);
  return storage;
}

afterEach(async () => {
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

async function tableExists(
  storage: StorageService,
  name: string,
): Promise<boolean> {
  const { rows } =
    storage.dialect === "sqlite"
      ? await sql`select name from sqlite_master where type = 'table' and name = ${name}`.execute(
          storage.db,
        )
      : await sql`select table_name from information_schema.tables where table_schema = current_schema() and table_name = ${name}`.execute(
          storage.db,
        );
  return rows.length > 0;
}

// Reads the maximum and inserts the next value; transactions that
// interleave would insert duplicates.
function insertNext(storage: StorageService): Promise<void> {
  return storage.transaction(async (db) => {
    const { rows } = await sql<{
      n: number | null;
    }>`select max(n) as n from t`.execute(db);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await sql`insert into t (n) values (${Number(rows[0]?.n ?? 0) + 1})`.execute(
      db,
    );
  });
}

const dialects = [
  { dialect: "sqlite", isAvailable: true, location: async () => undefined },
  {
    dialect: "postgres",
    isAvailable: POSTGRES_URL !== undefined,
    location: freshPostgresUrl,
  },
] as const;

for (const { dialect, isAvailable, location } of dialects) {
  const fresh = async () => open(await location());

  describe.skipIf(!isAvailable)(`on ${dialect}`, () => {
    runConformanceSuite(storageConformanceSuite, fresh);

    describe("a deliberately broken storage implementation", () => {
      it("fails the rollback invariant the suite is meant to catch", async () => {
        const real = await fresh();
        // Runs `fn` directly against the connection, so nothing rolls back.
        const broken: StorageService = {
          dialect: real.dialect,
          db: real.db,
          migrate: (owner, migrations) => real.migrate(owner, migrations),
          transaction: (fn) => fn(real.db),
        };
        const invariant = storageConformanceSuite.invariants.find(
          (candidate) =>
            candidate.name ===
            "a transaction that throws rolls back every change made inside it",
        );
        if (!invariant) throw new Error("expected the invariant to exist");
        await expect(
          Promise.resolve(invariant.check(broken)),
        ).rejects.toThrow();
      });
    });

    describe("createStorageService", () => {
      it(`reports the ${dialect} dialect`, async () => {
        expect((await fresh()).dialect).toBe(dialect);
      });

      it("runs queries against the database", async () => {
        const storage = await fresh();
        await sql`create table greetings (name text)`.execute(storage.db);
        await storage.db
          .insertInto("greetings" as never)
          .values({ name: "world" } as never)
          .execute();

        const rows = await storage.db
          .selectFrom("greetings" as never)
          .select("name" as never)
          .execute();
        expect(rows).toEqual([{ name: "world" }]);
      });

      it("applies each migration exactly once, tracked per owner", async () => {
        const storage = await fresh();
        const runsByOwner: string[] = [];
        const migrationFor = (owner: string) => [
          {
            id: "0001-create",
            async up(db: Kysely<unknown>) {
              runsByOwner.push(owner);
              await sql`create table ${sql.raw(`t_${owner.replaceAll("-", "_")}`)} (a integer)`.execute(
                db,
              );
            },
          },
        ];

        await storage.migrate("owner-a", migrationFor("owner-a"));
        await storage.migrate("owner-a", migrationFor("owner-a"));
        expect(runsByOwner).toEqual(["owner-a"]);

        await storage.migrate("owner-b", migrationFor("owner-b"));
        expect(runsByOwner).toEqual(["owner-a", "owner-b"]);
      });

      it("rolls back a migration that throws, leaving it unapplied", async () => {
        const storage = await fresh();
        await expect(
          storage.migrate("owner", [
            {
              id: "0001-bad",
              async up(db) {
                await sql`create table t (a integer)`.execute(db);
                throw new Error("boom");
              },
            },
          ]),
        ).rejects.toThrow("boom");

        expect(await tableExists(storage, "t")).toBe(false);
      });

      it("rolls back every change inside a failed transaction", async () => {
        const storage = await fresh();
        await sql`create table t (a integer)`.execute(storage.db);

        await expect(
          storage.transaction(async (db) => {
            await sql`insert into t values (1)`.execute(db);
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");

        const { rows } = await sql<{ a: number }>`select a from t`.execute(
          storage.db,
        );
        expect(rows).toEqual([]);
      });

      it("returns schema-builder integer columns as JS numbers, ms timestamps included", async () => {
        const storage = await fresh();
        await storage.db.schema
          .createTable("t")
          .addColumn("at", "integer", (c) => c.notNull())
          .execute();
        const at = Date.UTC(2100, 0, 1);
        await sql`insert into t (at) values (${at})`.execute(storage.db);

        const { rows } = await sql<{
          at: unknown;
          n: unknown;
        }>`select at, (select count(*) from t) as n from t`.execute(storage.db);
        expect(rows).toEqual([{ at, n: 1 }]);
      });

      it("round-trips schema-builder blob columns", async () => {
        const storage = await fresh();
        await storage.db.schema
          .createTable("t")
          .addColumn("bytes", "blob", (c) => c.notNull())
          .execute();
        const bytes = new Uint8Array([0, 1, 254, 255]);
        await sql`insert into t (bytes) values (${bytes})`.execute(storage.db);

        const { rows } = await sql<{
          bytes: Uint8Array;
        }>`select bytes from t`.execute(storage.db);
        expect(new Uint8Array(rows[0]?.bytes ?? [])).toEqual(bytes);
      });

      it("orders and compares schema-builder text columns by byte value", async () => {
        const storage = await fresh();
        await storage.db.schema
          .createTable("t")
          .addColumn("value", "text", (c) => c.primaryKey())
          .execute();
        await sql`insert into t (value) values ('b'), ('B'), ('a'), ('a:'), ('a/'), ('A')`.execute(
          storage.db,
        );

        const { rows } = await sql<{
          value: string;
        }>`select value from t order by value`.execute(storage.db);
        expect(rows.map((row) => row.value)).toEqual([
          "A",
          "B",
          "a",
          "a/",
          "a:",
          "b",
        ]);
        const range = await sql<{
          value: string;
        }>`select value from t where value >= 'a/' and value < 'a;' order by value`.execute(
          storage.db,
        );
        expect(range.rows.map((row) => row.value)).toEqual(["a/", "a:"]);
      });

      it("runs concurrent transactions one at a time", async () => {
        const storage = await fresh();
        await sql`create table t (n integer)`.execute(storage.db);
        await Promise.all(
          Array.from({ length: 20 }, () => insertNext(storage)),
        );
        const { rows } = await sql<{
          n: number;
        }>`select n from t order by n`.execute(storage.db);
        expect(rows.map((row) => Number(row.n))).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        );
      });

      it("disposes the underlying connection when the owning fiber unloads", async () => {
        const place = await location();
        const ctx = new Context();
        const fiber = await ctx.plugin((pluginCtx: Context) => {
          const storage = createStorageService(pluginCtx, place);
          pluginCtx.provide("storage", storage);
        });

        await fiber.dispose();
        expect(ctx.get("storage")).toBeUndefined();
      });

      it("waits for an in-flight migrate() call before closing on dispose", async () => {
        const place = await location();
        const ctx = new Context();
        let migrated = false;
        const fiber = await ctx.plugin((pluginCtx: Context) => {
          const storage = createStorageService(pluginCtx, place);
          // Deliberately not awaited: disposal must still wait for it rather
          // than closing the connection while this is still running.
          void storage.migrate("owner", [
            {
              id: "0001-slow",
              async up(db) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                await sql`create table t (a integer)`.execute(db);
                migrated = true;
              },
            },
          ]);
        });

        await fiber.dispose();

        expect(migrated).toBe(true);
      });

      it("waits for every in-flight migrate() call, not only the latest, before closing", async () => {
        const place = await location();
        let storage!: StorageService;
        const fiber = await new Context().plugin((ctx: Context) => {
          storage = createStorageService(ctx, place);
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const slow = storage.migrate("test.a", [
          {
            id: "0001",
            async up(db) {
              await gate;
              await sql`create table t_slow (value text)`.execute(db);
            },
          },
          {
            id: "0002",
            async up(db) {
              await sql`create table t_slow_2 (value text)`.execute(db);
            },
          },
        ]);
        const fast = storage.migrate("test.b", [
          {
            id: "0001",
            async up(db) {
              await sql`create table t_fast (value text)`.execute(db);
            },
          },
        ]);
        const disposed = fiber.dispose();
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await expect(Promise.all([slow, fast])).resolves.toEqual([
          undefined,
          undefined,
        ]);
        await disposed;
      });
    });
  });
}

describe("createStorageService on a SQLite file", () => {
  it("persists data across connections to the same file", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "docleus-storage-"));
    const path = join(dir, "test.sqlite");
    try {
      let first!: StorageService;
      const firstFiber = await new Context().plugin((ctx: Context) => {
        first = createStorageService(ctx, path);
      });
      await sql`create table t (a integer)`.execute(first.db);
      await sql`insert into t values (42)`.execute(first.db);
      await firstFiber.dispose();

      let second!: StorageService;
      const secondFiber = await new Context().plugin((ctx: Context) => {
        second = createStorageService(ctx, path);
      });
      const { rows } = await sql<{ a: number }>`select a from t`.execute(
        second.db,
      );
      expect(rows).toEqual([{ a: 42 }]);
      await secondFiber.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createStorageService locations", () => {
  it("refuses URL schemes it does not support, without echoing credentials", async () => {
    const error: unknown = await new Context()
      .plugin((ctx: Context) => {
        createStorageService(ctx, "mysql://user:secret@localhost/db");
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toMatchObject({ code: "storage/unsupported-location" });
    expect(String(error)).not.toContain("secret");
  });
});

describe.skipIf(POSTGRES_URL === undefined)(
  "createStorageService on one Postgres database from several services",
  () => {
    it("accepts postgresql:// URLs", async () => {
      const url = (await freshPostgresUrl()).replace(
        /^postgres:/,
        "postgresql:",
      );
      expect((await open(url)).dialect).toBe("postgres");
    });

    it("persists data across connections to the same database", async () => {
      const url = await freshPostgresUrl();
      let first!: StorageService;
      const firstFiber = await new Context().plugin((ctx: Context) => {
        first = createStorageService(ctx, url);
      });
      await sql`create table t (a integer)`.execute(first.db);
      await sql`insert into t values (42)`.execute(first.db);
      await firstFiber.dispose();

      const second = await open(url);
      const { rows } = await sql<{ a: number }>`select a from t`.execute(
        second.db,
      );
      expect(rows).toEqual([{ a: 42 }]);
    });

    it("applies a migration once when several processes migrate at the same time", async () => {
      const url = await freshPostgresUrl();
      const services = await Promise.all([open(url), open(url), open(url)]);
      let runs = 0;
      const migrations = [
        {
          id: "0001",
          async up(db: Kysely<unknown>) {
            runs += 1;
            await sql`create table t (a integer)`.execute(db);
          },
        },
      ];
      await Promise.all(
        services.map((storage) => storage.migrate("owner", migrations)),
      );
      expect(runs).toBe(1);
    });

    it("serializes transactions across services", async () => {
      const url = await freshPostgresUrl();
      const [a, b] = await Promise.all([open(url), open(url)]);
      await sql`create table t (n integer)`.execute(a.db);
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => insertNext(index % 2 ? a : b)),
      );
      const { rows } = await sql<{
        n: number;
      }>`select n from t order by n`.execute(a.db);
      expect(rows.map((row) => row.n)).toEqual(
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
    });
  },
);
