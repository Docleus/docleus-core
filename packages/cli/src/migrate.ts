import { parseArgs } from "node:util";
import { migrateInstance } from "@docleus/server";
import type { CliIo } from "./cli.ts";
import { resolveDeployment } from "./deployment.ts";

const USAGE = `usage: docleus migrate [--config <file>] [--bundle <file>] [--data <dir>] [--database <location>]

Runs the platform and plugin migrations, then exits without serving. SQLite is
backed up first. Takes the same config, data and database as docleus serve.

environment:
  DOCLEUS_DATABASE_URL  the database location, when neither --database nor the config sets it
`;

/** `docleus migrate`: migrates the database and content, then exits. Resolves to the exit code. */
export async function migrate(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string" },
        bundle: { type: "string" },
        data: { type: "string" },
        database: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  let deployment;
  try {
    deployment = resolveDeployment(values, env);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  const { database, blobSecret } = deployment;
  try {
    const { migratedSpaces } = await migrateInstance({
      dataDir: deployment.dataDir,
      ...(database && { database }),
      plugins: deployment.plugins,
      baseDir: deployment.baseDir,
      configFile: deployment.configFile,
      ...(blobSecret && { blobSecret }),
    });
    io.stdout(
      `docleus migrated; ${migratedSpaces.length} spaces committed at current block versions\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`migration failed: ${(error as Error).message}\n`);
    return 1;
  }
}
