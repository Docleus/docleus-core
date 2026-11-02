import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { npmPack, paxRecord, tar, tgz } from "../tests/tar-writer.ts";
import {
  readTarball,
  safeTarPath,
  stripTopLevel,
  writeTarEntries,
} from "./tar.ts";

const decoder = new TextDecoder();
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("readTarball", () => {
  it("reads files and directories of an npm pack archive", () => {
    const entries = readTarball(
      tgz([
        { path: "package/", type: "5", mode: 0o755 },
        { path: "package/package.json", data: "{}" },
        { path: "package/dist/server.js", data: "export {}", mode: 0o755 },
      ]),
    );
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ["package", "directory"],
      ["package/package.json", "file"],
      ["package/dist/server.js", "file"],
    ]);
    expect(decoder.decode(entries[2]?.data)).toBe("export {}");
    expect(entries[2]?.mode).toBe(0o755);
  });

  it("joins the ustar prefix, pax paths and GNU long names", () => {
    const long = `package/${"a".repeat(120)}.js`;
    const entries = readTarball(
      tgz([
        { path: "file.js", prefix: "package/deep", data: "1" },
        { path: "PaxHeader", type: "x", data: paxRecord("path", long) },
        { path: "truncated", data: "2" },
        { path: "././@LongLink", type: "L", data: `${long}x\0` },
        { path: "truncated", data: "3" },
        { path: "global", type: "g", data: paxRecord("comment", "hi") },
      ]),
    );
    expect(entries.map((e) => e.path)).toEqual([
      "package/deep/file.js",
      long,
      `${long}x`,
    ]);
  });

  it("normalizes ./ segments", () => {
    const [entry] = readTarball(tgz([{ path: "./package/./a.js", data: "" }]));
    expect(entry?.path).toBe("package/a.js");
  });

  it.each([
    ["an absolute path", { path: "/etc/passwd", data: "x" }],
    ["a parent segment", { path: "package/../../evil.js", data: "x" }],
    ["a bare parent", { path: "..", type: "5" }],
    ["a backslash", { path: "package\\..\\evil.js", data: "x" }],
    ["a drive letter", { path: "C:/evil.js", data: "x" }],
    ["a symlink", { path: "package/link", type: "2", linkName: "/etc" }],
    ["a hard link", { path: "package/hard", type: "1", linkName: "../x" }],
    ["a character device", { path: "package/dev", type: "3" }],
    ["a FIFO", { path: "package/fifo", type: "6" }],
  ])("refuses %s", (_label, entry) => {
    expect(() => readTarball(tgz([entry]))).toThrow(
      expect.objectContaining({ code: "plugin/invalid-tarball" }),
    );
  });

  it("refuses a pax path that escapes the root", () => {
    expect(() =>
      readTarball(
        tgz([
          { path: "PaxHeader", type: "x", data: paxRecord("path", "../x.js") },
          { path: "package/fine.js", data: "x" },
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "plugin/invalid-tarball" }));
  });

  it("refuses a bad checksum, truncation and non-gzip input", () => {
    const archive = tar([{ path: "package/a.js", data: "hello" }]);
    const corrupt = archive.slice();
    corrupt[0] = 0x41;
    const invalid = expect.objectContaining({ code: "plugin/invalid-tarball" });
    expect(() => readTarball(gzipSync(corrupt))).toThrow(invalid);
    expect(() => readTarball(gzipSync(archive.subarray(0, 514)))).toThrow(
      invalid,
    );
    expect(() => readTarball(new TextEncoder().encode("plain"))).toThrow(
      invalid,
    );
  });

  it("enforces the size and entry limits", () => {
    const big = tgz([{ path: "package/big", data: new Uint8Array(4096) }]);
    const invalid = expect.objectContaining({ code: "plugin/invalid-tarball" });
    expect(() => readTarball(big, { maxBytes: 2048, maxEntries: 10 })).toThrow(
      invalid,
    );
    const many = tgz([
      { path: "a", data: "" },
      { path: "b", data: "" },
    ]);
    expect(() =>
      readTarball(many, { maxBytes: 1 << 20, maxEntries: 1 }),
    ).toThrow(invalid);
  });
});

describe("safeTarPath", () => {
  it("keeps inner dots that are not parent segments", () => {
    expect(safeTarPath("package/..hidden/a..b.js")).toBe(
      "package/..hidden/a..b.js",
    );
  });
});

describe("stripTopLevel", () => {
  it("strips a shared top-level directory", () => {
    const entries = readTarball(
      npmPack({ "package.json": "{}", "dist/a.js": "" }),
    );
    expect(stripTopLevel(entries).map((e) => e.path)).toEqual([
      "package.json",
      "dist/a.js",
    ]);
  });

  it("keeps archives without a shared directory", () => {
    const entries = readTarball(
      tgz([
        { path: "a.js", data: "" },
        { path: "lib/b.js", data: "" },
      ]),
    );
    expect(stripTopLevel(entries).map((e) => e.path)).toEqual([
      "a.js",
      "lib/b.js",
    ]);
  });
});

describe("writeTarEntries", () => {
  it("writes files under the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "docleus-tar-"));
    dirs.push(root);
    const entries = stripTopLevel(
      readTarball(npmPack({ "docleus.plugin.json": "{}", "dist/a.js": "a" })),
    );
    await writeTarEntries(root, entries);
    expect((await readdir(root)).toSorted()).toEqual([
      "dist",
      "docleus.plugin.json",
    ]);
    expect(await readFile(join(root, "dist/a.js"), "utf8")).toBe("a");
    expect((await stat(join(root, "dist/a.js"))).mode & 0o777).toBe(0o644);
  });

  it("refuses an entry nested under a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "docleus-tar-"));
    dirs.push(root);
    const entries = readTarball(
      tgz([
        { path: "a", data: "file" },
        { path: "a/b", data: "nested" },
      ]),
    );
    await expect(writeTarEntries(root, entries)).rejects.toMatchObject({
      code: "plugin/invalid-tarball",
    });
  });
});
