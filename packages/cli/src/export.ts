import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInstance, type Instance } from "@docleus/server";
import type { CliIo } from "./cli.ts";
import { resolveDeployment } from "./deployment.ts";

const USAGE = `usage: docleus export --site <org>/<site> --out <dir> [--publication <id>] [--config <file>] [--bundle <file>] [--data <dir>] [--database <location>]\n\n  --site         the site to export, as <org slug>/<site slug>\n  --out          an empty or missing directory to write the site into\n  --publication  the publication to export (default: the active one)\n`;

/**
 * `docleus export`: writes a publication's files into a directory, ready for
 * any static file host. Resolves to the exit code.
 */
export async function exportSite(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        site: { type: "string" },
        out: { type: "string" },
        publication: { type: "string" },
        config: { type: "string" },
        database: { type: "string" },
        bundle: { type: "string" },
        data: { type: "string" },
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
  const [orgSlug, siteSlug, ...extra] = values.site?.split("/") ?? [];
  if (!orgSlug || !siteSlug || extra.length > 0) {
    io.stderr(`--site must be <org slug>/<site slug>\n${USAGE}`);
    return 2;
  }
  if (!values.out) {
    io.stderr(`--out is required\n${USAGE}`);
    return 2;
  }

  let deployment;
  try {
    deployment = resolveDeployment(values, env);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  const out = resolve(values.out);
  let instance: Instance | undefined;
  try {
    await assertEmptyDir(out);
    instance = await createInstance({
      dataDir: deployment.dataDir,
      configFile: deployment.configFile,
      database: deployment.database,
      blobSecret: deployment.blobSecret,
      role: "web",
      plugins: deployment.plugins,
      baseDir: deployment.baseDir,
    });
    const count = await writeSite(instance, {
      orgSlug,
      siteSlug,
      publication: values.publication,
      out,
    });
    io.stdout(`exported ${count} files to ${out}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  } finally {
    await instance?.dispose();
  }
}

async function assertEmptyDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ENOTDIR") {
      throw new Error(`${dir} is not a directory`, { cause: error });
    }
    throw error;
  }
  if (entries.length > 0) {
    throw new Error(
      `${dir} is not empty; export into an empty or missing directory`,
    );
  }
}

async function writeSite(
  instance: Instance,
  target: {
    orgSlug: string;
    siteSlug: string;
    publication: string | undefined;
    out: string;
  },
): Promise<number> {
  const { sites, blobs } = instance.ctx;
  const name = `${target.orgSlug}/${target.siteSlug}`;
  const site = await sites.findBySlug(target.orgSlug, target.siteSlug);
  if (!site) throw new Error(`site ${name} not found`);
  const id = target.publication ?? site.active;
  if (!id) throw new Error(`site ${name} has no active publication`);
  const publication = await sites.getPublication(id);
  if (publication?.siteId !== site.id) {
    throw new Error(`publication ${id} of site ${name} not found`);
  }
  const artifact = await sites.readArtifact(publication.artifact);
  const files = Object.entries(artifact.files);
  for (const [path, file] of files) {
    const destination = resolve(target.out, `.${path}`);
    const inside = relative(target.out, destination);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`artifact path ${path} leaves the output directory`);
    }
    const bytes = await blobs.get(file.hash);
    if (!bytes) throw new Error(`blob ${file.hash} of ${path} is missing`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return files.length;
}
