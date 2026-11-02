import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDeploymentOverrides,
  configRelativePath,
  deploymentPatch,
  readDeploymentConfig,
  writeDeploymentPlugins,
  type DeploymentPluginRow,
} from "./deployment-config.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function configFile(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "docleus-config-"));
  dirs.push(dir);
  const path = join(dir, "docleus.yaml");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

const INSTALLED: DeploymentPluginRow = {
  id: "@acme/stamp",
  plugin: "./plugins/@acme+stamp@1.0.0",
  version: "1.0.0",
  source: { type: "tarball", filename: "stamp-1.0.0.tgz" },
  sha256: "a".repeat(64),
};

describe("deployment config", () => {
  it("reads an absent file as an empty config", () => {
    expect(readDeploymentConfig(configFile())).toEqual({ plugins: [] });
  });

  it("reads serve options and plugin rows", () => {
    const path = configFile(
      [
        "database: postgres://docleus@db/docleus",
        "port: 8080",
        "publicUrl: https://docs.example.com",
        "trustProxy: true",
        "role: worker",
        "siteCache: { maxBytes: 1048576 }",
        "plugins:",
        "  - id: search-db",
        "    disabled: true",
        "  - id: blobs",
        "    plugin: ./node_modules/@docleus/plugin-blobs-s3",
        "    config: { bucket: docs }",
        "",
      ].join("\n"),
    );
    expect(readDeploymentConfig(path)).toEqual({
      database: "postgres://docleus@db/docleus",
      port: 8080,
      publicUrl: "https://docs.example.com",
      trustProxy: true,
      role: "worker",
      siteCache: { maxBytes: 1048576 },
      plugins: [
        { id: "search-db", disabled: true },
        {
          id: "blobs",
          plugin: "./node_modules/@docleus/plugin-blobs-s3",
          config: { bucket: "docs" },
        },
      ],
    });
  });

  it.each([
    ["unknown keys", "colour: blue\n"],
    ["a bad role", "role: cron\n"],
    ["a bad public URL", "publicUrl: ftp://example.com\n"],
    ["a negative cache size", "siteCache: { maxBytes: -1 }\n"],
    ["a bad sha256", "plugins:\n  - id: a\n    sha256: nope\n"],
    ["a bad source", "plugins:\n  - id: a\n    source: { type: npm }\n"],
    ["duplicate ids", "plugins:\n  - id: a\n  - id: a\n"],
    ["invalid YAML", "plugins: [\n"],
  ])("refuses %s", (_, text) => {
    expect(() => readDeploymentConfig(configFile(text))).toThrow(
      expect.objectContaining({ code: "config/invalid-deployment" }),
    );
  });

  it("writes the plugin list into a new file", async () => {
    const path = configFile();
    await writeDeploymentPlugins(path, [INSTALLED]);
    expect(readDeploymentConfig(path)).toEqual({ plugins: [INSTALLED] });
  });

  it("keeps other keys and comments when rewriting the plugin list", async () => {
    const path = configFile(
      [
        "# Production deployment",
        "port: 8080 # behind Caddy",
        "plugins:",
        "  - id: old",
        "",
      ].join("\n"),
    );
    await writeDeploymentPlugins(path, [INSTALLED]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# Production deployment");
    expect(text).toContain("port: 8080 # behind Caddy");
    expect(readDeploymentConfig(path)).toEqual({
      port: 8080,
      plugins: [INSTALLED],
    });
  });

  it("refuses to rewrite a file that is not a mapping", async () => {
    const path = configFile("- a\n- b\n");
    await expect(writeDeploymentPlugins(path, [])).rejects.toMatchObject({
      code: "config/invalid-deployment",
    });
  });

  it("resolves plugin paths against the file's directory", () => {
    const path = configFile();
    const dir = join(path, "..");
    expect(
      deploymentPatch(path, [INSTALLED, { id: "x", disabled: true }]),
    ).toEqual([
      { id: "@acme/stamp", plugin: join(dir, "plugins/@acme+stamp@1.0.0") },
      { id: "x", disabled: true },
    ]);
    expect(configRelativePath(path, join(dir, "plugins", "a@1.0.0"))).toBe(
      "./plugins/a@1.0.0",
    );
    expect(configRelativePath(path, "/elsewhere/a")).toBe("/elsewhere/a");
  });

  describe("overrides", () => {
    const OIDC: DeploymentPluginRow = {
      id: "oidc",
      disabled: false,
      config: { sources: [{ id: "sso", issuer: "https://a.example" }] },
    };

    it("creates the file with a header", async () => {
      const path = configFile();
      expect(
        await applyDeploymentOverrides(
          path,
          { publicUrl: "https://docs.example.com", plugins: [OIDC] },
          { header: "Written by the image." },
        ),
      ).toBe(true);
      expect(readFileSync(path, "utf8")).toMatch(/^# Written by the image\.\n/);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(readDeploymentConfig(path)).toEqual({
        publicUrl: "https://docs.example.com",
        plugins: [OIDC],
      });
    });

    it("replaces stored values and keeps everything else", async () => {
      const path = configFile(
        [
          "# Production deployment",
          "publicUrl: https://old.example.com",
          "port: 8080 # behind Caddy",
          "plugins:",
          "  - id: oidc",
          "    disabled: true",
          "    config:",
          "      allowLocalLogin: false",
          "      sources:",
          "        - id: old",
          "          issuer: https://old.example",
          "  - id: '@acme/stamp' # installed from the admin UI",
          "    plugin: ./plugins/@acme+stamp@1.0.0",
          "",
        ].join("\n"),
      );
      expect(
        await applyDeploymentOverrides(path, {
          publicUrl: "https://docs.example.com",
          trustProxy: true,
          plugins: [OIDC, { id: "blobs", config: { bucket: "docs" } }],
        }),
      ).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("# Production deployment");
      expect(text).toContain("port: 8080 # behind Caddy");
      expect(text).toContain("# installed from the admin UI");
      expect(readDeploymentConfig(path)).toEqual({
        publicUrl: "https://docs.example.com",
        trustProxy: true,
        port: 8080,
        plugins: [
          {
            id: "oidc",
            disabled: false,
            config: {
              allowLocalLogin: false,
              sources: [{ id: "sso", issuer: "https://a.example" }],
            },
          },
          { id: "@acme/stamp", plugin: "./plugins/@acme+stamp@1.0.0" },
          { id: "blobs", config: { bucket: "docs" } },
        ],
      });
    });

    it("leaves the file untouched when nothing changes", async () => {
      const path = configFile("publicUrl: https://docs.example.com # set\n");
      const before = (await stat(path)).mtimeMs;
      expect(
        await applyDeploymentOverrides(path, {
          publicUrl: "https://docs.example.com",
          trustProxy: undefined,
        }),
      ).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(
        "publicUrl: https://docs.example.com # set\n",
      );
      expect((await stat(path)).mtimeMs).toBe(before);
    });

    it("refuses invalid overrides", async () => {
      const path = configFile("port: 8080\n");
      await expect(
        applyDeploymentOverrides(path, { publicUrl: "not a url" }),
      ).rejects.toMatchObject({ code: "config/invalid-overrides" });
      await expect(
        applyDeploymentOverrides(path, JSON.parse('{"port": 1}') as object),
      ).rejects.toMatchObject({ code: "config/invalid-overrides" });
      expect(readFileSync(path, "utf8")).toBe("port: 8080\n");
    });

    it("refuses to write a stored config that is invalid", async () => {
      const path = configFile("port: high\n");
      await expect(
        applyDeploymentOverrides(path, { plugins: [{ id: "oidc" }] }),
      ).rejects.toMatchObject({ code: "config/invalid-deployment" });
      expect(readFileSync(path, "utf8")).toBe("port: high\n");
    });
  });
});
