#!/usr/bin/env node
import { run } from "./cli.ts";
import { configure } from "./configure.ts";
import { exportSite } from "./export.ts";
import { migrate } from "./migrate.ts";
import { serve } from "./serve.ts";

const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};
const argv = process.argv.slice(2);

async function main(): Promise<boolean> {
  if (argv[0] === "export") {
    process.exitCode = await exportSite(argv.slice(1), io);
    return false;
  }
  if (argv[0] === "configure") {
    process.exitCode = await configure(argv.slice(1), io);
    return false;
  }
  if (argv[0] === "migrate") {
    process.exitCode = await migrate(argv.slice(1), io);
    return false;
  }
  if (argv[0] !== "serve") {
    process.exitCode = run(argv, io);
    return false;
  }
  const served = await serve(argv.slice(1), io);
  if (typeof served === "number") {
    process.exitCode = served;
    return false;
  }
  const stop = () => {
    served.dispose().then(
      () => process.exit(0),
      (error: unknown) => {
        io.stderr(`${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return true;
}

/** Whether a server is still running once this module has loaded. */
export const isServing = await main();
