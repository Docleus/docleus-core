import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupBeforeMigrating, bootStateOf, prepareBoot } from "./backup.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "docleus-backup-"));
  dirs.push(dir);
  return dir;
}

function createDatabase(path: string, value: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run(value);
  db.close();
}

function valueIn(path: string): unknown {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT v FROM t").get()?.v;
  } finally {
    db.close();
  }
}

const PLUGINS = [
  { name: "b", version: "1.0.0" },
  { name: "a", version: "2.0.0" },
];

describe("backups before migrations", () => {
  it("records the platform and sorted plugin versions", () => {
    expect(bootStateOf("0.0.1", PLUGINS)).toEqual({
      platform: "0.0.1",
      plugins: ["a@2.0.0", "b@1.0.0"],
    });
  });

  it("skips a fresh data directory", async () => {
    const dir = dataDir();
    const boot = await prepareBoot({
      dataDir: dir,
      database: undefined,
      plugins: PLUGINS,
      platform: "0.0.1",
    });
    expect(boot.backup).toBeUndefined();
    await boot.finish();
    expect(existsSync(join(dir, "boot-state.json"))).toBe(true);
  });

  it("backs up when versions changed since the last boot, and only then", async () => {
    const dir = dataDir();
    createDatabase(join(dir, "docleus.db"), "before");
    const boot = (platform: string) =>
      prepareBoot({
        dataDir: dir,
        database: undefined,
        plugins: PLUGINS,
        platform,
      });

    const first = await boot("0.0.1");
    expect(first.backup).toMatch(
      /backups\/docleus-\d{4}-\d{2}-\d{2}T\d{6}Z\.db$/,
    );
    expect(valueIn(first.backup ?? "")).toBe("before");
    await first.finish();

    const same = await boot("0.0.1");
    expect(same.backup).toBeUndefined();
    await same.finish();

    const upgraded = await boot("0.2.0");
    expect(upgraded.backup).toBeDefined();
    expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
  });

  it("does not overwrite a backup taken in the same second", async () => {
    const dir = dataDir();
    const database = join(dir, "docleus.db");
    createDatabase(database, "x");
    const now = new Date("2026-10-27T10:00:00.123Z");
    const state = bootStateOf("0.0.1", []);
    const a = await backupBeforeMigrating({
      dataDir: dir,
      database,
      state,
      now,
    });
    const b = await backupBeforeMigrating({
      dataDir: dir,
      database,
      state,
      now,
    });
    expect(a).toBe(join(dir, "backups", "docleus-2026-10-27T100000Z.db"));
    expect(b).toBe(join(dir, "backups", "docleus-2026-10-27T100000Z-1.db"));
  });

  it("leaves database URLs alone", async () => {
    const dir = dataDir();
    const boot = await prepareBoot({
      dataDir: dir,
      database: "postgres://docleus@db/docleus",
      plugins: [],
      platform: "0.0.1",
    });
    expect(boot.backup).toBeUndefined();
  });
});
