import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DocleusError } from "@docleus/kernel";

/** A regular file or directory read from a tarball. */
export interface TarEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly mode: number;
  readonly data: Uint8Array;
}

export interface TarLimits {
  /** Upper bound on the unpacked archive size in bytes. */
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
};

const BLOCK = 512;
const decoder = new TextDecoder();

function invalid(message: string, cause?: unknown): DocleusError {
  return new DocleusError(
    "plugin/invalid-tarball",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const field = text(block, offset, length).trim();
  if (field === "") return 0;
  if (!/^[0-7]+$/.test(field)) throw invalid(`bad numeric field "${field}"`);
  return Number.parseInt(field, 8);
}

function checksumOf(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  }
  return sum;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/** Pax extended header records: `<length> <key>=<value>\n`. */
function parsePax(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw invalid("bad pax record");
    const length = Number(decoder.decode(data.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= space - offset) {
      throw invalid("bad pax record length");
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length));
    const equals = record.indexOf("=");
    if (equals === -1 || !record.endsWith("\n")) {
      throw invalid("bad pax record");
    }
    records.set(record.slice(0, equals), record.slice(equals + 1, -1));
    offset += length;
  }
  return records;
}

/**
 * Normalizes an archive path, refusing anything that could land outside the
 * extraction root: absolute paths, `..` segments, backslashes and NUL bytes.
 */
export function safeTarPath(raw: string): string {
  if (raw.includes("\0") || raw.includes("\\")) {
    throw invalid(`unsafe path "${raw}"`);
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw invalid(`absolute path "${raw}"`);
  }
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) throw invalid(`path escapes root "${raw}"`);
  if (segments.length === 0) throw invalid(`empty path "${raw}"`);
  return segments.join("/");
}

/**
 * Reads a gzipped ustar archive (the `npm pack` format). Only regular files
 * and directories are accepted; links, devices and FIFOs are refused.
 */
export function readTarball(
  gzipped: Uint8Array,
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): TarEntry[] {
  let archive: Uint8Array;
  try {
    archive = gunzipSync(gzipped, { maxOutputLength: limits.maxBytes });
  } catch (error) {
    throw invalid("not a gzip archive or larger than the limit", error);
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;
    if (octal(header, 148, 8) !== checksumOf(header)) {
      throw invalid(`bad header checksum at offset ${offset}`);
    }
    const type = String.fromCharCode(header[156] ?? 0);
    const size = octal(header, 124, 12);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > archive.length) throw invalid("truncated archive");
    const data = archive.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    const isUstar = text(header, 257, 6).startsWith("ustar");
    const prefix = isUstar ? text(header, 345, 155) : "";
    const name = text(header, 0, 100);
    const raw =
      pax?.get("path") ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    pax = undefined;
    longName = undefined;

    let kind: TarEntry["type"];
    if (type === "0" || type === "\0" || type === "7") kind = "file";
    else if (type === "5") kind = "directory";
    else throw invalid(`unsupported entry type "${type}" for "${raw}"`);

    if (entries.length >= limits.maxEntries) {
      throw invalid(`more than ${limits.maxEntries} entries`);
    }
    entries.push({
      path: safeTarPath(raw),
      type: kind,
      mode: octal(header, 100, 8) & 0o777,
      data: kind === "file" ? data : new Uint8Array(),
    });
  }
  return entries;
}

/** Drops a top-level directory every entry sits under, like npm's `package/`. */
export function stripTopLevel(entries: readonly TarEntry[]): TarEntry[] {
  const first = entries[0]?.path.split("/")[0];
  if (first === undefined) return [];
  const isShared = entries.every(
    (entry) =>
      entry.path.startsWith(`${first}/`) ||
      (entry.path === first && entry.type === "directory"),
  );
  if (!isShared || !entries.some((e) => e.path.startsWith(`${first}/`))) {
    return [...entries];
  }
  return entries
    .filter((entry) => entry.path !== first)
    .map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) }));
}

/** Writes entries under `root`, which must be a fresh directory. */
export async function writeTarEntries(
  root: string,
  entries: readonly TarEntry[],
): Promise<void> {
  const files = new Set<string>();
  for (const entry of entries) {
    for (
      let i = entry.path.indexOf("/");
      i !== -1;
      i = entry.path.indexOf("/", i + 1)
    ) {
      if (files.has(entry.path.slice(0, i))) {
        throw invalid(`"${entry.path}" is inside a file`);
      }
    }
    const target = join(root, entry.path);
    if (entry.type === "directory") {
      if (files.has(entry.path)) throw invalid(`"${entry.path}" is a file`);
      await mkdir(target, { recursive: true });
      continue;
    }
    files.add(entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data, {
      mode: entry.mode & 0o111 ? 0o755 : 0o644,
    });
  }
}
