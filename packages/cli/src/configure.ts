import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  applyDeploymentOverrides,
  DEPLOYMENT_CONFIG_FILE,
  DeploymentOverridesSchema,
} from "@docleus/server";
import type { CliIo } from "./cli.ts";

const USAGE = `usage: docleus configure [--config <file>] [--data <dir>] [--header <text>] --set <json>

Writes settings into the deployment config (--config, else <data>/docleus.yaml)
and keeps its other keys, plugin rows and comments. <json> is an object with
any of publicUrl, trustProxy and plugins; plugin rows are matched by id, and
an object config replaces only the config keys it has. Run it before every
boot to keep settings that are managed elsewhere, such as in the environment.
--header is the comment that starts the file when it does not exist yet.
`;

/** `docleus configure`: writes settings into the deployment config. Resolves to the exit code. */
export async function configure(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string" },
        data: { type: "string" },
        set: { type: "string" },
        header: { type: "string" },
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
  if (values.set === undefined) {
    io.stderr(`--set is required\n${USAGE}`);
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(values.set);
  } catch (error) {
    io.stderr(`--set is not JSON: ${(error as Error).message}\n`);
    return 2;
  }
  const overrides = DeploymentOverridesSchema.safeParse(json);
  if (!overrides.success) {
    const details = overrides.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    io.stderr(`--set is invalid: ${details}\n`);
    return 2;
  }
  const file = values.config
    ? resolve(values.config)
    : join(resolve(values.data ?? ".docleus"), DEPLOYMENT_CONFIG_FILE);
  try {
    const isChanged = await applyDeploymentOverrides(
      file,
      overrides.data,
      values.header === undefined ? {} : { header: values.header },
    );
    if (isChanged) io.stdout(`docleus configure: wrote ${file}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  }
}
