import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DocleusError } from "@docleus/kernel";
import type { Manifest } from "@docleus/sdk";
import type { PluginSource } from "./deployment-config.ts";
import { readManifest } from "./resolve-plugin.ts";
import { readTarball, stripTopLevel, writeTarEntries } from "./tar.ts";

const run = promisify(execFile);

/** Where to install a plugin from. */
export type InstallRequest =
  | { readonly type: "path"; readonly path: string }
  | {
      readonly type: "tarball";
      readonly data: Uint8Array;
      readonly filename?: string;
    }
  | { readonly type: "git"; readonly url: string; readonly ref: string };

/** A plugin unpacked into a staging directory, not yet mounted. */
export interface StagedPlugin {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly source: PluginSource;
  readonly sha256: string;
}

export interface StageOptions {
  /** Upper bound on the time a git fetch or a build may take. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SKIPPED_IN_TREE_HASH = new Set([".git", "node_modules"]);
/** Git transports an install may use; `ext::` and other helpers are refused. */
const GIT_PROTOCOLS = "file:git:http:https:ssh";
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_IN_TREE_HASH.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * A digest of a directory's regular files (paths and contents), ignoring
 * `.git` and `node_modules`, independent of file system order.
 */
export async function treeHash(root: string): Promise<string> {
  const files = (await listFiles(root)).toSorted();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0${sha256(await readFile(join(root, file)))}\n`);
  }
  return hash.digest("hex");
}

function installFailed(message: string, cause?: unknown): DocleusError {
  return new DocleusError(
    "plugin/install-failed",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function missingEntries(dir: string, manifest: Manifest): string[] {
  const files = [
    ...Object.values(manifest.entries),
    ...Object.values(manifest.exposes),
    ...Object.values(manifest.islands),
  ].filter((file): file is string => file !== undefined);
  return files.filter((file) => !existsSync(resolve(dir, file)));
}

async function stageTarball(
  dir: string,
  data: Uint8Array,
  filename: string | undefined,
): Promise<Omit<StagedPlugin, "manifest">> {
  await writeTarEntries(dir, stripTopLevel(readTarball(data)));
  return {
    dir,
    source: { type: "tarball", ...(filename && { filename }) },
    sha256: sha256(data),
  };
}

async function stagePath(
  dir: string,
  path: string,
): Promise<Omit<StagedPlugin, "manifest">> {
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    throw new DocleusError("plugin/invalid-path", `${path} does not exist`);
  }
  if (info.isFile()) {
    await mkdir(dir, { recursive: true });
    const staged = await stageTarball(dir, await readFile(path), undefined);
    return { ...staged, source: { type: "path", path } };
  }
  await cp(path, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !relative(path, source).split(sep).includes(".git"),
  });
  return { dir, source: { type: "path", path }, sha256: await treeHash(dir) };
}

async function git(dir: string, args: readonly string[], timeout: number) {
  try {
    const { stdout } = await run("git", [...args], {
      cwd: dir,
      timeout,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: GIT_PROTOCOLS,
      },
    });
    return stdout.trim();
  } catch (error) {
    throw installFailed(`git ${args[0] ?? ""} failed`, error);
  }
}

async function pnpm(
  dir: string,
  args: readonly string[],
  timeout: number,
  hint = "",
): Promise<void> {
  // A clone without its own workspace file would otherwise join a workspace
  // above the data directory (such as a development checkout).
  const isWorkspace = existsSync(join(dir, "pnpm-workspace.yaml"));
  const all = [...args, ...(isWorkspace ? [] : ["--ignore-workspace"])];
  try {
    await run("pnpm", all, {
      cwd: dir,
      timeout,
      env: { ...process.env, CI: "true" },
    });
  } catch (error) {
    throw installFailed(`pnpm ${args.join(" ")} failed${hint}`, error);
  }
}

async function hasDependencies(dir: string): Promise<boolean> {
  const text = await readFile(join(dir, "package.json"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    throw installFailed("package.json is not valid JSON", error);
  }
  return isObject(pkg) && isObject(pkg.dependencies)
    ? Object.keys(pkg.dependencies).length > 0
    : false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Installs a cloned plugin's production dependencies. Dev dependencies are
 * skipped: in a plugin repository they are usually `link:`s into a
 * workspace that does not exist next to the clone. A ref without its
 * built files is built first, which needs those dev dependencies.
 */
async function installDependencies(
  dir: string,
  manifest: Manifest,
  timeout: number,
): Promise<void> {
  const frozen = existsSync(join(dir, "pnpm-lock.yaml"))
    ? ["--frozen-lockfile"]
    : [];
  if (missingEntries(dir, manifest).length > 0) {
    const hint = "; commit the built files to install without building";
    await pnpm(dir, ["install", ...frozen, "--ignore-scripts"], timeout, hint);
    await pnpm(dir, ["run", "build"], timeout, hint);
  }
  if (await hasDependencies(dir)) {
    await pnpm(
      dir,
      ["install", ...frozen, "--prod", "--ignore-scripts"],
      timeout,
    );
  } else {
    await rm(join(dir, "node_modules"), { recursive: true, force: true });
  }
}

async function stageGit(
  dir: string,
  url: string,
  ref: string,
  timeout: number,
): Promise<Omit<StagedPlugin, "manifest">> {
  if (url.startsWith("-") || /\s/.test(url)) {
    throw new DocleusError("plugin/invalid-source", `invalid git URL "${url}"`);
  }
  if (!SAFE_REF.test(ref) || ref.includes("..")) {
    throw new DocleusError("plugin/invalid-source", `invalid git ref "${ref}"`);
  }
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet"], timeout);
  await git(dir, ["fetch", "--quiet", "--depth", "1", "--", url, ref], timeout);
  await git(dir, ["checkout", "--quiet", "--detach", "FETCH_HEAD"], timeout);
  const commit = await git(dir, ["rev-parse", "HEAD"], timeout);
  const tree = await git(dir, ["rev-parse", "HEAD^{tree}"], timeout);
  await rm(join(dir, ".git"), { recursive: true, force: true });
  await installDependencies(dir, readManifest(dir), timeout);
  return {
    dir,
    source: { type: "git", url, ref, commit },
    sha256: sha256(`${commit}\n${tree}\n`),
  };
}

/**
 * Unpacks, copies or clones a plugin into `dir` (which must not exist) and
 * reads its manifest, refusing one whose engines range excludes this
 * platform (`plugin/engines-mismatch`) or whose entry files are missing.
 */
export async function stagePlugin(
  dir: string,
  request: InstallRequest,
  options: StageOptions = {},
): Promise<StagedPlugin> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let staged: Omit<StagedPlugin, "manifest">;
  switch (request.type) {
    case "tarball":
      await mkdir(dir, { recursive: true });
      staged = await stageTarball(dir, request.data, request.filename);
      break;
    case "path":
      staged = await stagePath(dir, request.path);
      break;
    case "git":
      staged = await stageGit(dir, request.url, request.ref, timeout);
      break;
  }
  const manifest = readManifest(dir);
  const missing = missingEntries(dir, manifest);
  if (missing.length > 0) {
    throw installFailed(
      `${manifest.name} is missing ${missing.join(", ")}; a tarball must contain its built files`,
    );
  }
  return { ...staged, manifest };
}
