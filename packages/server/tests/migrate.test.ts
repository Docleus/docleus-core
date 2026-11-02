import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_ENTRY_TYPE } from "@docleus/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createInstance, migrateInstance } from "../src/index.ts";
import { fixtures } from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-migrate-"));
  dirs.push(dir);
  return dir;
}

function appliedMigrations(dir: string): string[] {
  const db = new DatabaseSync(join(dir, "docleus.db"), { readOnly: true });
  try {
    return db
      .prepare("select key from _docleus_migrations")
      .all()
      .map((row) => String(row["key"]));
  } finally {
    db.close();
  }
}

describe("migrateInstance", () => {
  it("runs the platform migrations of a new database and exits", async () => {
    const dir = await dataDir();
    expect(await migrateInstance({ dataDir: dir, baseDir: fixtures })).toEqual({
      migratedSpaces: [],
    });
    expect(appliedMigrations(dir)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^@docleus\/core-identity::/),
        expect.stringMatching(/^@docleus\/core-content::/),
        "@docleus/core-jobs::0002-add-lease",
        expect.stringMatching(/^@docleus\/core-sites::/),
      ]),
    );
  });

  it("commits every space with its blocks at their current versions", async () => {
    const dir = await dataDir();
    const before = await createInstance({ dataDir: dir, baseDir: fixtures });
    const { content } = before.ctx;
    const org = await content.createOrg({ slug: "acme", name: "Acme" });
    const space = await content.createSpace({
      orgId: org.id,
      slug: "docs",
      name: "Docs",
    });
    const note = { id: "n", type: "test.note", v: 1, attrs: {} };
    await content.commit({
      spaceId: space.id,
      parent: undefined,
      put: {
        home: {
          type: PAGE_ENTRY_TYPE,
          title: "Home",
          parent: undefined,
          order: 0,
          fields: {},
          body: { id: "root", type: "doc", v: 1, attrs: {}, content: [note] },
        },
      },
      message: "1",
    });
    await before.dispose();

    const options = {
      dataDir: dir,
      baseDir: fixtures,
      plugins: [{ id: "note", plugin: "note-v2" }],
    };
    expect(await migrateInstance(options)).toEqual({
      migratedSpaces: [space.id],
    });
    expect(await migrateInstance(options)).toEqual({ migratedSpaces: [] });
  });

  it("rejects when a plugin migration fails", async () => {
    await expect(
      migrateInstance({
        dataDir: await dataDir(),
        baseDir: fixtures,
        plugins: [{ id: "bad", plugin: "bad-migration" }],
      }),
    ).rejects.toThrow("broken migration");
  });
});
