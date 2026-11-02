import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstance } from "@docleus/server";
import { afterEach, describe, expect, it } from "vitest";
import { exportSite } from "../src/index.ts";

const fixtures = fileURLToPath(
  new URL("../../server/tests/fixtures/", import.meta.url),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function page(title: string, order: number) {
  return {
    type: "page",
    title,
    parent: undefined,
    order,
    fields: {},
    body: { id: "root", type: "doc", v: 1, attrs: {}, content: [] },
  };
}

/** A data directory holding site acme/docs with two publications. */
async function publishedData() {
  const data = await tempDir("docleus-export-data-");
  const instance = await createInstance({
    dataDir: data,
    siteRuntimeDir: `${fixtures}site-runtime`,
  });
  try {
    const { content, sites } = instance.ctx;
    const org = await content.createOrg({ slug: "acme", name: "Acme" });
    const space = await content.createSpace({
      orgId: org.id,
      slug: "docs",
      name: "Docs",
    });
    const first = await content.commit({
      spaceId: space.id,
      parent: undefined,
      put: { home: page("Home", 0) },
      message: "Initial",
    });
    const site = await sites.create({
      orgId: org.id,
      slug: "docs",
      name: "Docs",
      theme: undefined,
      domain: undefined,
      spaces: [{ spaceId: space.id, path: "" }],
    });
    const older = await sites.publish(site.id);
    await content.commit({
      spaceId: space.id,
      parent: first.id,
      put: { guide: page("Guide", 1) },
      message: "Guide",
    });
    await sites.publish(site.id);
    return { data, older: older.id };
  } finally {
    await instance.dispose();
  }
}

function io() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (text: string) => (out.stdout += text),
      stderr: (text: string) => (out.stderr += text),
    },
  };
}

async function listFiles(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length))
    .toSorted();
}

describe("docleus export", () => {
  it("writes the active publication into the output directory", async () => {
    const { data } = await publishedData();
    const out = join(await tempDir("docleus-export-out-"), "site");
    const { out: streams, io: cliIo } = io();
    const code = await exportSite(
      ["--site", "acme/docs", "--out", out, "--data", data],
      cliIo,
    );
    expect(streams.stderr).toBe("");
    expect(code).toBe(0);
    const files = await listFiles(out);
    expect(files).toEqual(
      expect.arrayContaining([
        "/index.html",
        "/guide/index.html",
        "/404.html",
        "/_assets/docleus/runtime.js",
        "/_assets/docleus/vendor/react.js",
      ]),
    );
    expect(streams.stdout).toContain(`exported ${files.length} files`);
    expect(
      await readFile(join(out, "_assets/docleus/runtime.js"), "utf8"),
    ).toBe(await readFile(`${fixtures}site-runtime/runtime.js`, "utf8"));
  });

  it("exports an earlier publication by id", async () => {
    const { data, older } = await publishedData();
    const out = await tempDir("docleus-export-out-");
    const code = await exportSite(
      [
        "--site",
        "acme/docs",
        "--out",
        out,
        "--data",
        data,
        "--publication",
        older,
      ],
      io().io,
    );
    expect(code).toBe(0);
    const files = await listFiles(out);
    expect(files).toContain("/index.html");
    expect(files).not.toContain("/guide/index.html");
  });

  it("refuses a non-empty output directory", async () => {
    const { data } = await publishedData();
    const out = await tempDir("docleus-export-out-");
    await writeFile(join(out, "keep.txt"), "x");
    const { out: streams, io: cliIo } = io();
    const code = await exportSite(
      ["--site", "acme/docs", "--out", out, "--data", data],
      cliIo,
    );
    expect(code).toBe(1);
    expect(streams.stderr).toContain("is not empty");
    expect(await readdir(out)).toEqual(["keep.txt"]);
  });

  it("reports unknown sites and publications", async () => {
    const { data } = await publishedData();
    const out = await tempDir("docleus-export-out-");
    const missing = io();
    expect(
      await exportSite(
        ["--site", "acme/nope", "--out", out, "--data", data],
        missing.io,
      ),
    ).toBe(1);
    expect(missing.out.stderr).toContain("site acme/nope not found");
    const unknown = io();
    expect(
      await exportSite(
        [
          "--site",
          "acme/docs",
          "--out",
          out,
          "--data",
          data,
          "--publication",
          "x",
        ],
        unknown.io,
      ),
    ).toBe(1);
    expect(unknown.out.stderr).toContain(
      "publication x of site acme/docs not found",
    );
  });

  it("rejects bad arguments with exit code 2", async () => {
    const dir = await tempDir("docleus-export-out-");
    expect(await exportSite(["--out", dir], io().io)).toBe(2);
    expect(await exportSite(["--site", "acme", "--out", dir], io().io)).toBe(2);
    expect(await exportSite(["--site", "acme/docs"], io().io)).toBe(2);
    const help = io();
    expect(await exportSite(["--help"], help.io)).toBe(0);
    expect(help.out.stdout).toContain("--publication");
  });
});
