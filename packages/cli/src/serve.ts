import { parseArgs } from "node:util";
import {
  ROLES,
  createInstance,
  listen,
  createSmtpMailer,
  type Instance,
  type Listening,
  type Mailer,
  type Role,
} from "@docleus/server";
import type { CliIo } from "./cli.ts";
import { appDirOption, siteRuntimeDirOption } from "./defaults.ts";
import { resolveDeployment, type Deployment } from "./deployment.ts";

const USAGE = `usage: docleus serve [--config <file>] [--bundle <file>] [--data <dir>] [--database <location>] [--role all|web|worker] [--port <n>] [--host <name>] [--app <dir>] [--site-runtime <dir>] [--public-url <url>] [--trust-proxy] [--dev]

  --config        the deployment config file (default: <data>/docleus.yaml); flags override its keys, and plugin installs are recorded in it
  --data          the data directory (default: the config's "data", else .docleus)
  --database      a SQLite file path or a postgres:// URL (default: <data>/docleus.db)
  --role          all (default) serves HTTP and runs jobs; web only serves HTTP; worker only runs jobs
  --app           the built @docleus/app (default: its dist directory, when built)
  --site-runtime  the built site runtime copied into published sites (default: @docleus/app's dist-site, when built)
  --public-url    the URL people open the instance at, used in invitation links (default: the request's origin)
  --trust-proxy   trust X-Forwarded-* headers from a reverse proxy
  --dev           development login: any email signs in as an instance admin

environment:
  DOCLEUS_DATABASE_URL  the database location, when neither --database nor the config sets it
  DOCLEUS_BLOB_SECRET   signs blob URLs, at least 32 characters; web and worker processes need the same one (default: generated once into <data>/blob-secret)
  DOCLEUS_SMTP_URL   SMTP connection URL for invitation emails, e.g. smtps://user:pass@smtp.example.com
  DOCLEUS_SMTP_FROM  sender address for those emails; required with DOCLEUS_SMTP_URL
`;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** A serving instance; a `worker` has no HTTP listener and an empty `url`. */
export interface Served extends Listening {
  /** The running instance, for embedding and tests. */
  readonly instance: Instance;
  dispose(): Promise<void>;
}

/**
 * `docleus serve`: boots an instance from a bundle and serves it over HTTP.
 * Resolves once listening, or to an exit code when the arguments are wrong.
 */
export async function serve(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Served | number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: "string" },
        bundle: { type: "string" },
        data: { type: "string" },
        database: { type: "string" },
        role: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        app: { type: "string" },
        "site-runtime": { type: "string" },
        "public-url": { type: "string" },
        "trust-proxy": { type: "boolean" },
        dev: { type: "boolean" },
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
  const role = values.role ?? "all";
  if (!isRole(role)) {
    io.stderr(`--role must be one of ${ROLES.join(", ")}\n${USAGE}`);
    return 2;
  }
  let deployment: Deployment;
  try {
    deployment = resolveDeployment(values, env);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  const { config, fromConfig } = deployment;

  const port =
    values.port === undefined ? (config.port ?? 3000) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.stderr(`--port must be a port number\n${USAGE}`);
    return 2;
  }

  const publicUrl = values["public-url"] ?? config.publicUrl;
  if (publicUrl !== undefined && !isHttpUrl(publicUrl)) {
    io.stderr(`--public-url must be an http or https URL\n${USAGE}`);
    return 2;
  }
  const smtpUrl = env["DOCLEUS_SMTP_URL"] || undefined;
  const smtpFrom = env["DOCLEUS_SMTP_FROM"] || undefined;
  if ((smtpUrl === undefined) !== (smtpFrom === undefined)) {
    io.stderr(
      `DOCLEUS_SMTP_URL and DOCLEUS_SMTP_FROM must be set together\n${USAGE}`,
    );
    return 2;
  }
  const mailer: Mailer | undefined =
    smtpUrl && smtpFrom
      ? createSmtpMailer({ url: smtpUrl, from: smtpFrom })
      : undefined;

  const appDir = appDirOption(values.app ?? fromConfig(config.app));
  const siteRuntimeDir = siteRuntimeDirOption(
    values["site-runtime"] ?? fromConfig(config.siteRuntime),
  );
  const { database, blobSecret } = deployment;
  const instance = await createInstance({
    dataDir: deployment.dataDir,
    ...(database && { database }),
    plugins: deployment.plugins,
    baseDir: deployment.baseDir,
    configFile: deployment.configFile,
    role,
    ...(blobSecret && { blobSecret }),
    ...(appDir && { appDir }),
    ...(siteRuntimeDir && { siteRuntimeDir }),
    isDev: values.dev === true,
    ...(publicUrl && { publicUrl }),
    trustProxy: values["trust-proxy"] === true || config.trustProxy === true,
    ...(mailer && { mailer }),
  });
  if (role === "worker") {
    io.stdout("docleus worker running jobs\n");
    return {
      instance,
      url: "",
      close: async () => undefined,
      dispose: () => instance.dispose(),
    };
  }
  const hostname = values.host ?? config.host;
  const listening = await listen(instance, {
    port,
    ...(hostname && { hostname }),
  });
  if (values.dev) {
    io.stderr(
      "warning: --dev enables a login that makes anyone an instance admin\n",
    );
  }
  io.stdout(`docleus listening on ${listening.url}\n`);
  if (instance.setupToken !== undefined) {
    const origin = (publicUrl ?? listening.url).replace(/\/+$/, "");
    io.stdout(
      `no users yet: open ${origin}/setup and enter the setup token ${instance.setupToken}\n`,
    );
  }
  return {
    instance,
    url: listening.url,
    close: () => listening.close(),
    async dispose() {
      await listening.close();
      await instance.dispose();
    },
  };
}
