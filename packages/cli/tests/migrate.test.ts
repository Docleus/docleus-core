import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/index.ts";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

function io() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (text: string) => (out.stdout += text),
      stderr: (text: string) => (out.stderr += text),
    },
  };
}

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-migrate-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function migrationCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare("select count(*) as n from _docleus_migrations")
      .get();
    return Number(row?.["n"]);
  } finally {
    db.close();
  }
}

describe("docleus migrate", () => {
  it("migrates the database of the data directory and exits", async () => {
    const data = await dataDir();
    const { out, io: streams } = io();
    expect(await migrate(["--data", data], streams, {})).toBe(0);
    expect(out.stdout).toContain("migrated");
    expect(migrationCount(join(data, "docleus.db"))).toBeGreaterThan(0);
    expect(existsSync(join(data, "docleus.yaml"))).toBe(false);
  });

  it("backs up an existing SQLite database whose versions changed", async () => {
    const data = await dataDir();
    const { io: streams } = io();
    expect(await migrate(["--data", data], streams, {})).toBe(0);
    expect(existsSync(join(data, "backups"))).toBe(false);
    // Without the recorded state of the last boot, the versions count as changed.
    await rm(join(data, "boot-state.json"));
    expect(await migrate(["--data", data], streams, {})).toBe(0);
    expect(readdirSync(join(data, "backups"))).toHaveLength(1);
  });

  it("takes the database from the config, then DOCLEUS_DATABASE_URL", async () => {
    const data = await dataDir();
    const { out, io: streams } = io();
    expect(
      await migrate(["--data", data], streams, {
        DOCLEUS_DATABASE_URL: join(data, "env.db"),
      }),
    ).toBe(0);
    expect(existsSync(join(data, "env.db"))).toBe(true);

    await writeFile(join(data, "docleus.yaml"), "database: ./config.db\n");
    expect(
      await migrate(["--data", data], streams, {
        DOCLEUS_DATABASE_URL: join(data, "env.db"),
      }),
    ).toBe(0);
    expect(existsSync(join(data, "config.db"))).toBe(true);
    expect(out.stderr).toBe("");
  });

  it("rejects unknown flags and an invalid config file with exit code 2", async () => {
    const data = await dataDir();
    const { out, io: streams } = io();
    expect(await migrate(["--port", "1"], streams, {})).toBe(2);
    expect(out.stderr).toContain("usage: docleus migrate");
    await writeFile(join(data, "docleus.yaml"), "colour: blue\n");
    expect(await migrate(["--data", data], streams, {})).toBe(2);
    expect(out.stderr).toContain("colour");
  });

  it("exits with 1 when the database cannot be opened", async () => {
    const { out, io: streams } = io();
    expect(
      await migrate(
        ["--data", await dataDir(), "--database", "mysql://nowhere/db"],
        streams,
        {},
      ),
    ).toBe(1);
    expect(out.stderr).toContain("migration failed");
  });
});
