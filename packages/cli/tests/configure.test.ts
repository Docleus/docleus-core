import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure } from "../src/index.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-configure-"));
  dirs.push(dir);
  return dir;
}

function set(publicUrl: string): string {
  return JSON.stringify({
    publicUrl,
    plugins: [{ id: "oidc", config: { publicUrl } }],
  });
}

describe("docleus configure", () => {
  it("writes the settings on every run and keeps the rest of the file", async () => {
    const data = await dataDir();
    const file = join(data, "docleus.yaml");
    const first = io();
    expect(
      await configure(
        [
          "--data",
          data,
          "--header",
          "From the environment.",
          "--set",
          set("https://a.example"),
        ],
        first.io,
      ),
    ).toBe(0);
    expect(first.out.stdout).toContain(`wrote ${file}`);
    expect(await readFile(file, "utf8")).toMatch(/^# From the environment\./);

    await writeFile(
      file,
      `${await readFile(file, "utf8")}port: 8080 # edited by hand\n`,
    );
    expect(
      await configure(
        ["--data", data, "--set", set("https://b.example")],
        io().io,
      ),
    ).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("publicUrl: https://b.example");
    expect(text).not.toContain("https://a.example");
    expect(text).toContain("port: 8080 # edited by hand");

    const unchanged = io();
    expect(
      await configure(
        ["--data", data, "--set", set("https://b.example")],
        unchanged.io,
      ),
    ).toBe(0);
    expect(unchanged.out.stdout).toBe("");
  });

  it("exits with 2 on a missing, malformed or invalid --set", async () => {
    const data = await dataDir();
    for (const argv of [
      ["--data", data],
      ["--data", data, "--set", "{"],
      ["--data", data, "--set", '{"port": 1}'],
      ["--data", data, "--set", '{"publicUrl": "not a url"}'],
    ]) {
      expect(await configure(argv, io().io)).toBe(2);
    }
  });

  it("exits with 1 when the config file is invalid", async () => {
    const data = await dataDir();
    await writeFile(join(data, "docleus.yaml"), "- a\n");
    const { out, io: streams } = io();
    expect(
      await configure(
        ["--data", data, "--set", '{"trustProxy": true}'],
        streams,
      ),
    ).toBe(1);
    expect(out.stderr).toContain("expected a mapping");
  });
});
