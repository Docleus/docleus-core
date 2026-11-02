import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BLOB_SECRET_FILE, type Instance } from "../src/index.ts";
import { bootWith } from "./helpers.ts";

const instances: Instance[] = [];
const dirs: string[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-blob-secret-"));
  dirs.push(dir);
  return dir;
}

const HASH = "a".repeat(64);
const SECRET = "s".repeat(32);

function signed(instance: Instance): string {
  return instance.ctx.blobs.sign(HASH, Date.now() + 60_000);
}

describe("blob signing secret", () => {
  it("verifies a URL signed by another instance with the same secret", async () => {
    const web = await boot({ dataDir: await dataDir(), blobSecret: SECRET });
    const worker = await boot({
      dataDir: await dataDir(),
      role: "worker",
      blobSecret: SECRET,
    });
    expect(worker.ctx.blobs.verify(signed(web))).toBe(HASH);
    expect(web.ctx.blobs.verify(signed(worker))).toBe(HASH);
  });

  it("rejects a URL signed with another secret", async () => {
    const first = await boot({ blobSecret: SECRET });
    const second = await boot({ blobSecret: "t".repeat(32) });
    expect(second.ctx.blobs.verify(signed(first))).toBeUndefined();
  });

  it("keeps a generated secret in the data directory across restarts", async () => {
    const dir = await dataDir();
    const first = await boot({ dataDir: dir });
    const token = signed(first);
    await first.dispose();
    instances.splice(instances.indexOf(first), 1);

    const file = join(dir, BLOB_SECRET_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
    const second = await boot({ dataDir: dir });
    expect(second.ctx.blobs.verify(token)).toBe(HASH);
  });

  it("refuses a secret shorter than 32 characters", async () => {
    await expect(boot({ blobSecret: "short" })).rejects.toMatchObject({
      code: "config/invalid-blob-secret",
    });
  });
});
