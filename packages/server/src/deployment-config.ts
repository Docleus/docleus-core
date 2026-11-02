import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DocleusError, type ConfigPatchRow } from "@docleus/kernel";
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, parseDocument, stringify } from "yaml";
import { z } from "zod";

const SHA256 = /^[0-9a-f]{64}$/;

export const PluginSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("path"), path: z.string().min(1) }),
  z.strictObject({
    type: z.literal("tarball"),
    filename: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  }),
]);

/** Where an installed plugin came from. */
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/**
 * A plugin row of the deployment config: a config patch row, plus the pinned
 * version, source and sha256 for plugins installed at runtime.
 */
export const DeploymentPluginRowSchema = z.strictObject({
  id: z.string().min(1),
  plugin: z.string().min(1).optional(),
  config: z.unknown().optional(),
  disabled: z.boolean().optional(),
  version: z.string().min(1).optional(),
  source: PluginSourceSchema.optional(),
  sha256: z.string().regex(SHA256).optional(),
});

export type DeploymentPluginRow = z.infer<typeof DeploymentPluginRowSchema>;

export const ROLES = ["all", "web", "worker"] as const;

/** Which work a process does: `web` serves HTTP, `worker` runs jobs, `all` both. */
export type Role = (typeof ROLES)[number];

export const DeploymentConfigSchema = z.strictObject({
  /** Data directory; relative paths in this file resolve against the file's directory. */
  data: z.string().min(1).optional(),
  /** A SQLite file path or a `postgres://` URL; `<data>/docleus.db` when omitted. */
  database: z.string().min(1).optional(),
  bundle: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  host: z.string().min(1).optional(),
  publicUrl: z.url({ protocol: /^https?$/ }).optional(),
  trustProxy: z.boolean().optional(),
  role: z.enum(ROLES).optional(),
  app: z.string().min(1).optional(),
  siteRuntime: z.string().min(1).optional(),
  /** The disk cache of blobs for site serving under `<data>/cache/blobs`; `maxBytes: 0` turns it off. */
  siteCache: z.strictObject({ maxBytes: z.number().int().min(0) }).optional(),
  /**
   * Rows patching the bundle's plugin rows, plus plugins installed at
   * runtime. A row for a plugin that provides `blobs` (such as
   * `docleus-plugin-blobs-s3`) replaces the local blob directory `<data>/blobs`.
   */
  plugins: z.array(DeploymentPluginRowSchema).default([]),
});

export type DeploymentConfig = z.output<typeof DeploymentConfigSchema>;

/** The deployment config file name inside the data directory. */
export const DEPLOYMENT_CONFIG_FILE = "docleus.yaml";

function invalid(path: string, message: string, cause?: unknown): DocleusError {
  return new DocleusError(
    "config/invalid-deployment",
    `${path}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Reads a deployment config file; an absent file is an empty config. */
export function readDeploymentConfig(path: string): DeploymentConfig {
  if (!existsSync(path)) return DeploymentConfigSchema.parse({});
  const document = parseDocument(readFileSync(path, "utf8"));
  if (document.errors.length > 0) {
    throw invalid(path, "invalid YAML", document.errors[0]);
  }
  const result = DeploymentConfigSchema.safeParse(document.toJS() ?? {});
  if (!result.success) throw invalid(path, describeIssues(result.error));
  const ids = new Set<string>();
  for (const row of result.data.plugins) {
    if (ids.has(row.id)) throw invalid(path, `duplicate plugin id "${row.id}"`);
    ids.add(row.id);
  }
  return result.data;
}

/** Resolves a path in the config file against the file's directory. */
export function resolveConfigPath(configFile: string, path: string): string {
  return resolve(dirname(configFile), path);
}

/**
 * The plugin rows as a config patch. Plugin specifiers are local paths,
 * resolved against the config file's directory.
 */
export function deploymentPatch(
  configFile: string,
  rows: readonly DeploymentPluginRow[],
): ConfigPatchRow[] {
  return rows.map((row) => ({
    id: row.id,
    ...(row.plugin !== undefined && {
      plugin: resolveConfigPath(configFile, row.plugin),
    }),
    ...(row.config !== undefined && { config: row.config }),
    ...(row.disabled !== undefined && { disabled: row.disabled }),
  }));
}

/** A path to write into the config file: relative when it is under the file's directory. */
export function configRelativePath(configFile: string, path: string): string {
  const rel = relative(dirname(configFile), path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return `./${rel.split(sep).join("/")}`;
}

/** The YAML document of an existing config file whose root is a mapping, else `undefined`. */
function readMappingDocument(path: string): Document | undefined {
  if (!existsSync(path)) return undefined;
  const document = parseDocument(readFileSync(path, "utf8"));
  if (document.errors.length > 0) {
    throw invalid(path, "invalid YAML", document.errors[0]);
  }
  if (document.contents === null) return undefined;
  if (!isMap(document.contents)) throw invalid(path, "expected a mapping");
  return document;
}

/** Replaces a file atomically; a new file is readable by its owner only. */
async function replaceFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = existsSync(path) ? (await stat(path)).mode & 0o777 : 0o600;
  // Random, not the pid: processes in separate containers can share a pid.
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

/**
 * Replaces the plugin list of a deployment config file, keeping its other
 * keys and comments. The file is replaced atomically.
 */
export async function writeDeploymentPlugins(
  path: string,
  rows: readonly DeploymentPluginRow[],
): Promise<void> {
  const plain = rows.map((row) => DeploymentPluginRowSchema.parse(row));
  const document = readMappingDocument(path);
  if (document === undefined) {
    await replaceFile(path, stringify({ plugins: plain }, { lineWidth: 0 }));
    return;
  }
  document.set("plugins", document.createNode(plain));
  await replaceFile(path, document.toString({ lineWidth: 0 }));
}

/** Settings for {@link applyDeploymentOverrides}; an omitted key is left as it is. */
export const DeploymentOverridesSchema = z.strictObject({
  publicUrl: DeploymentConfigSchema.shape.publicUrl,
  trustProxy: DeploymentConfigSchema.shape.trustProxy,
  /**
   * Rows matched to the file's plugin rows by id. A new id is appended. For
   * an existing row, every key given replaces the stored one, except that
   * an object `config` replaces only the config keys it has.
   */
  plugins: z.array(DeploymentPluginRowSchema).optional(),
});

export type DeploymentOverrides = z.input<typeof DeploymentOverridesSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Writes `overrides` into a deployment config file, keeping its other keys,
 * plugin rows and comments, so that settings managed elsewhere (such as the
 * environment of a container) win on every boot. Creates the file, starting
 * with `header` as a comment, when it does not exist. The result must be a
 * valid deployment config. Resolves to whether the file changed.
 */
export async function applyDeploymentOverrides(
  path: string,
  overrides: DeploymentOverrides,
  { header }: { header?: string } = {},
): Promise<boolean> {
  const parsed = DeploymentOverridesSchema.safeParse(overrides);
  if (!parsed.success) {
    throw new DocleusError(
      "config/invalid-overrides",
      `invalid deployment overrides: ${describeIssues(parsed.error)}`,
    );
  }
  const { publicUrl, trustProxy, plugins = [] } = parsed.data;
  const existing = readMappingDocument(path);
  const document = existing ?? new Document({});
  if (existing === undefined && header !== undefined) {
    document.commentBefore = header
      .split("\n")
      .map((line) => ` ${line}`)
      .join("\n");
  }
  let isChanged = false;
  const setIn = (keys: readonly (string | number)[], value: unknown) => {
    let stored: unknown = document.toJS();
    for (const key of keys) {
      stored =
        stored !== null && typeof stored === "object"
          ? (stored as Record<string | number, unknown>)[key]
          : undefined;
    }
    if (isDeepStrictEqual(stored, value)) return;
    document.setIn(keys, document.createNode(value));
    isChanged = true;
  };
  if (publicUrl !== undefined) setIn(["publicUrl"], publicUrl);
  if (trustProxy !== undefined) setIn(["trustProxy"], trustProxy);
  for (const plain of plugins) {
    const stored: unknown = document.toJS();
    const rows =
      isPlainObject(stored) && Array.isArray(stored["plugins"])
        ? (stored["plugins"] as unknown[])
        : undefined;
    if (rows === undefined) {
      setIn(["plugins"], [plain]);
      continue;
    }
    const index = rows.findIndex(
      (candidate) => isPlainObject(candidate) && candidate["id"] === plain.id,
    );
    if (index === -1) {
      setIn(["plugins", rows.length], plain);
      continue;
    }
    const current = rows[index] as Record<string, unknown>;
    for (const [key, value] of Object.entries(plain)) {
      if (
        key === "config" &&
        isPlainObject(value) &&
        isPlainObject(current[key])
      ) {
        for (const [configKey, configValue] of Object.entries(value)) {
          setIn(["plugins", index, key, configKey], configValue);
        }
      } else {
        setIn(["plugins", index, key], value);
      }
    }
  }
  if (!isChanged && existing !== undefined) return false;
  const text = document.toString({ lineWidth: 0 });
  const result = DeploymentConfigSchema.safeParse(
    parseDocument(text).toJS() ?? {},
  );
  if (!result.success) throw invalid(path, describeIssues(result.error));
  await replaceFile(path, text);
  return true;
}
