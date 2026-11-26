import { Context, type Fiber } from "@docleus/kernel";
import { createStorageService } from "@docleus/core-storage";
import { testStorageLocation } from "@docleus/testing";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createContentService } from "./index.ts";

const fibers: Fiber[] = [];
afterEach(async () => {
  for (const fiber of fibers.splice(0).toReversed()) await fiber.dispose();
});

async function setup() {
  const location = await testStorageLocation();
  const ctx = new Context();
  fibers.push(
    await ctx.plugin((owner: Context) => {
      owner.provide("storage", createStorageService(owner, location));
    }),
  );
  const first = createContentService(ctx);
  const other = location ? new Context() : ctx;
  if (location) {
    fibers.push(
      await other.plugin((owner: Context) => {
        owner.provide("storage", createStorageService(owner, location));
      }),
    );
  }
  const second = createContentService(other);
  await ctx.storage.transaction(async (db) => {
    await sql`create table projection_results (seq integer primary key)`.execute(
      db,
    );
  });
  await first.append("test/event", {});
  return { ctx, other, first, second };
}

describe("shared projection runners", () => {
  it("applies an entry once when two runners read the same database", async () => {
    const { ctx, other, first, second } = await setup();
    const seen: number[] = [];
    const projectionFor = (owner: Context) => ({
      name: "test/shared",
      reset: async () => {},
      async apply(entry: { seq: number }) {
        seen.push(entry.seq);
        await owner.storage.transaction(async (db) => {
          await sql`insert into projection_results values (${entry.seq})`.execute(
            db,
          );
        });
      },
    });
    const projection = projectionFor(ctx);
    first.registerProjection(projection);
    second.registerProjection(projectionFor(other));
    await Promise.all([
      first.catchUp(projection.name),
      second.catchUp(projection.name),
    ]);
    expect(seen).toEqual([1]);
  });

  it("rolls projection writes back with the cursor when apply fails", async () => {
    const { ctx, first } = await setup();
    let hasFailed = false;
    const projection = {
      name: "test/rollback",
      reset: async () => {},
      async apply(entry: { seq: number }) {
        await ctx.storage.transaction(async (db) => {
          await sql`insert into projection_results values (${entry.seq})`.execute(
            db,
          );
        });
        if (!hasFailed) {
          hasFailed = true;
          throw new Error("interrupted");
        }
      },
    };
    first.registerProjection(projection);
    await expect(first.catchUp(projection.name)).rejects.toThrow("interrupted");
    expect(
      (await sql`select * from projection_results`.execute(ctx.storage.db))
        .rows,
    ).toEqual([]);
    await first.catchUp(projection.name);
    expect(
      (await sql`select * from projection_results`.execute(ctx.storage.db))
        .rows,
    ).toEqual([{ seq: 1 }]);
  });
});
