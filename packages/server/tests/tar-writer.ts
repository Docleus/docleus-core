import { gzipSync } from "node:zlib";

/** A raw archive member for tests; `type` is the ustar type flag. */
export interface RawTarEntry {
  readonly path: string;
  readonly type?: string;
  readonly data?: string | Uint8Array;
  readonly linkName?: string;
  readonly mode?: number;
  readonly prefix?: string;
}

const encoder = new TextEncoder();

function put(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  header.set(encoder.encode(value).subarray(0, length), offset);
}

function putOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  put(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
  );
}

function headerBlock(entry: RawTarEntry, size: number): Uint8Array {
  const block = new Uint8Array(512);
  put(block, 0, 100, entry.path);
  putOctal(block, 100, 8, entry.mode ?? 0o644);
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  putOctal(block, 124, 12, size);
  putOctal(block, 136, 12, 0);
  put(block, 156, 1, entry.type ?? "0");
  put(block, 157, 100, entry.linkName ?? "");
  put(block, 257, 6, "ustar\0");
  put(block, 263, 2, "00");
  put(block, 345, 155, entry.prefix ?? "");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  putOctal(block, 148, 7, sum);
  block[155] = 0x20;
  return block;
}

/** Builds an uncompressed ustar archive. */
export function tar(entries: readonly RawTarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const data =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    chunks.push(headerBlock(entry, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Builds a gzipped ustar archive, like `npm pack`. */
export function tgz(entries: readonly RawTarEntry[]): Uint8Array {
  return gzipSync(tar(entries));
}

/** A pax record line for an `x` entry body. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length++;
  return `${length}${body}`;
}

/** Packs files as `package/<path>`, the layout `npm pack` produces. */
export function npmPack(files: Readonly<Record<string, string>>): Uint8Array {
  return tgz(
    Object.entries(files).map(([path, data]) => ({
      path: `package/${path}`,
      data,
    })),
  );
}
