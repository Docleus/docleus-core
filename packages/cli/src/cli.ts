import { parseArgs } from "node:util";
import { dumpResolvedConfig } from "@docleus/server";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `usage: docleus --dump-config --bundle <file> [--profile <file>] [--deployment <file>] [--patch <file>]...\n       docleus serve --help\n       docleus migrate --help\n       docleus configure --help\n       docleus export --help\n`;

export function run(argv: readonly string[], io: CliIo): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "dump-config": { type: "boolean" },
        bundle: { type: "string" },
        profile: { type: "string" },
        deployment: { type: "string" },
        patch: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  if (values.help || !values["dump-config"]) {
    io.stdout(USAGE);
    return values.help ? 0 : 2;
  }
  if (!values.bundle) {
    io.stderr(`--bundle is required\n${USAGE}`);
    return 2;
  }

  try {
    io.stdout(
      dumpResolvedConfig({
        bundle: values.bundle,
        ...(values.profile && { profile: values.profile }),
        ...(values.deployment && { deployment: values.deployment }),
        ...(values.patch && { patches: values.patch }),
      }),
    );
    return 0;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  }
}
