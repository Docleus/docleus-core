import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const BOOT_STATE_FILE = "boot-state.json";

const BootStateSchema = z.object({
  platform: z.string(),
  plugins: z.array(z.string()),
});

/** What a boot ran: the platform version and every plugin's `name@version`. */
export type BootState = z.infer<typeof BootStateSchema>;

export function bootStateOf(
  platform: string,
  plugins: Iterable<{ readonly name: string; readonly version: string }>,
): BootState {
  return {
    platform,
    plugins: [...plugins].map((p) => `${p.name}@${p.version}`).toSorted(),
  };
}

function readBootState(dataDir: string): {
  readonly state?: BootState;
  readonly invalid?: Buffer;
} {
  const path = join(dataDir, BOOT_STATE_FILE);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { invalid: raw };
  }
  const result = BootStateSchema.safeParse(value);
  return result.success ? { state: result.data } : { invalid: raw };
}

export async function writeBootState(
  dataDir: string,
  state: BootState,
): Promise<void> {
  const path = join(dataDir, BOOT_STATE_FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

function isSameState(a: BootState, b: BootState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Copies a SQLite database into `<dataDir>/backups/` with `VACUUM INTO`
 * when the platform or plugin versions differ from the last boot's, so the
 * migrations about to run can be undone. Returns the backup path, if any.
 */
export async function backupBeforeMigrating(options: {
  readonly dataDir: string;
  readonly database: string;
  readonly state: BootState;
  readonly now?: Date;
}): Promise<string | undefined> {
  const { dataDir, database, state } = options;
  if (!existsSync(database)) return undefined;
  const previous = readBootState(dataDir);
  if (previous.state && isSameState(previous.state, state)) return undefined;
  const stamp = (options.now ?? new Date())
    .toISOString()
    .replaceAll(":", "")
    .replace(/\.\d+Z$/, "Z");
  const backups = join(dataDir, "backups");
  await mkdir(backups, { recursive: true });
  let target = join(backups, `docleus-${stamp}.db`);
  for (let n = 1; existsSync(target); n++) {
    target = join(backups, `docleus-${stamp}-${n}.db`);
  }
  const db = new DatabaseSync(database);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  if (previous.invalid) {
    await writeFile(`${target}.boot-state.json`, previous.invalid, {
      flag: "wx",
    });
  }
  return target;
}

const URL_LOCATION = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Prepares a boot on a data directory: backs up the SQLite database when
 * versions changed since the last boot. `finish` records this boot's state
 * once it succeeded.
 */
export async function prepareBoot(options: {
  readonly dataDir: string | undefined;
  readonly database: string | undefined;
  readonly plugins: Iterable<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly platform: string;
}): Promise<{ readonly backup?: string; finish(): Promise<void> }> {
  const { dataDir } = options;
  if (!dataDir) return { finish: async () => undefined };
  const state = bootStateOf(options.platform, options.plugins);
  const database = options.database ?? join(dataDir, "docleus.db");
  const backup = URL_LOCATION.test(database)
    ? undefined
    : await backupBeforeMigrating({ dataDir, database, state });
  return {
    ...(backup && { backup }),
    finish: () => writeBootState(dataDir, state),
  };
}
