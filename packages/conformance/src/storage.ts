import type { Migration, StorageService } from "@docleus/sdk";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import { defineConformanceSuite, expectToReject } from "./suite.ts";

async function count(db: Kysely<unknown>, table: string): Promise<number> {
  const result = await sql<{
    n: number;
  }>`select count(*) as n from ${sql.table(table)}`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

function createTable(name: string, log: string[] = []): Migration {
  return {
    id: `create-${name}`,
    async up(db) {
      log.push(name);
      await sql`create table ${sql.table(name)} (value text)`.execute(db);
    },
  };
}

export const storageConformanceSuite = defineConformanceSuite<StorageService>(
  "storage",
  [
    {
      name: "a migration runs once per owner, however often migrate is called",
      async check(storage) {
        const log: string[] = [];
        await storage.migrate("test.owner", [createTable("t_once", log)]);
        await storage.migrate("test.owner", [createTable("t_once", log)]);
        expect(log).toEqual(["t_once"]);
      },
    },
    {
      name: "migration ids are scoped to their owner",
      async check(storage) {
        const log: string[] = [];
        const shared = (table: string): Migration => ({
          id: "0001",
          async up(db) {
            log.push(table);
            await sql`create table ${sql.table(table)} (value text)`.execute(
              db,
            );
          },
        });
        await storage.migrate("test.a", [shared("t_a")]);
        await storage.migrate("test.b", [shared("t_b")]);
        expect(log).toEqual(["t_a", "t_b"]);
      },
    },
    {
      name: "migrations run in the order given, and new ones run after applied ones",
      async check(storage) {
        const log: string[] = [];
        await storage.migrate("test.owner", [createTable("t_1", log)]);
        await storage.migrate("test.owner", [
          createTable("t_1", log),
          createTable("t_2", log),
          createTable("t_3", log),
        ]);
        expect(log).toEqual(["t_1", "t_2", "t_3"]);
      },
    },
    {
      name: "a failing migration is rolled back, not recorded, and runs again next time",
      async check(storage) {
        let attempts = 0;
        const flaky: Migration = {
          id: "flaky",
          async up(db) {
            attempts += 1;
            await sql`create table t_flaky (value text)`.execute(db);
            if (attempts === 1) throw new Error("first attempt fails");
          },
        };
        await expectToReject(() => storage.migrate("test.owner", [flaky]));
        await storage.migrate("test.owner", [flaky]);
        expect(attempts).toBe(2);
        expect(await count(storage.db, "t_flaky")).toBe(0);
      },
    },
    {
      name: "a transaction that throws rolls back every change made inside it",
      async check(storage) {
        await storage.migrate("test.owner", [createTable("t_tx")]);
        await expectToReject(() =>
          storage.transaction(async (trx) => {
            await sql`insert into t_tx (value) values ('a')`.execute(trx);
            throw new Error("abort");
          }),
        );
        expect(await count(storage.db, "t_tx")).toBe(0);
      },
    },
    {
      name: "a transaction that resolves commits and returns its value",
      async check(storage) {
        await storage.migrate("test.owner", [createTable("t_tx")]);
        const result = await storage.transaction(async (trx) => {
          await sql`insert into t_tx (value) values ('a')`.execute(trx);
          return "done";
        });
        expect(result).toBe("done");
        expect(await count(storage.db, "t_tx")).toBe(1);
      },
    },
  ],
);
