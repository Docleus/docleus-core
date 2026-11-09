import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { cp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { testStorageDialect, testStorageLocation } from "@docleus/testing";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Instance } from "../src/index.ts";
import {
  account,
  bootWith,
  fixtures,
  ORIGIN,
  type Account,
  type Client,
} from "./helpers.ts";
import { npmPack } from "./tar-writer.ts";

const instances: Instance[] = [];
const dirs: string[] = [];
const boot = bootWith(instances);
const NAME = "@test/installable";
const ENCODED = encodeURIComponent(NAME);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function filesOf(root: string, dir = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, filesOf(root, path));
    else files[relative(root, path)] = readFileSync(path, "utf8");
  }
  return files;
}

const installable = () => filesOf(join(fixtures, "installable"));

/** The one installed plugin directory under `<dataDir>/plugins`. */
function installedDir(dataDir: string): string {
  const installed = readdirSync(join(dataDir, "plugins")).filter(
    (dir) => dir !== "node_modules",
  );
  expect(installed).toHaveLength(1);
  return join(dataDir, "plugins", installed[0] ?? "");
}

/** The installable fixture under another name, with another block type. */
function renamed(name: string): Record<string, string> {
  const files = installable();
  const manifest = JSON.parse(files["docleus.plugin.json"] ?? "{}") as Record<
    string,
    unknown
  >;
  files["docleus.plugin.json"] = JSON.stringify({ ...manifest, name });
  files["server/index.js"] = (files["server/index.js"] ?? "")
    .replaceAll("@test/installable", name)
    .replaceAll("test.stamp", "test.second");
  files["editor/index.js"] = (files["editor/index.js"] ?? "").replaceAll(
    "test.stamp",
    "test.second",
  );
  return files;
}

/** The installable fixture, same version, rendering another class. */
function restyled(suffix: string): Record<string, string> {
  const files = installable();
  files["server/index.js"] = (files["server/index.js"] ?? "").replace(
    'class="test-stamp"',
    `class="test-stamp-${suffix}"`,
  );
  return files;
}

/** A Git repository with one commit of `source` on `main`. */
async function commitRepo(
  source: string,
  change?: (repo: string) => Promise<void>,
): Promise<{ repo: string; commit: string }> {
  const repo = tempDir("docleus-git-");
  await cp(source, repo, { recursive: true });
  await change?.(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    })
      .toString()
      .trim();
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("commit", "--quiet", "--no-gpg-sign", "-m", "init");
  return { repo, commit: git("rev-parse", "HEAD") };
}

function installGit(admin: Account, repo: string): Promise<Response> {
  return admin.api.call("POST", "/api/plugins", {
    type: "git",
    url: `file://${repo}`,
    ref: "main",
  });
}

function greetingOf(instance: Instance): string {
  return instance.ctx.render.render({
    id: "greeting",
    type: "test.greeting",
    v: 1,
    attrs: {},
  }).html;
}

async function bootData(dataDir = tempDir("docleus-install-")) {
  const configFile = join(dataDir, "docleus.yaml");
  const instance = await boot({ dataDir, configFile });
  const admin = await account(instance, "admin@example.com", { isAdmin: true });
  return { instance, admin, dataDir, configFile };
}

function upload(
  instance: Instance,
  user: Account,
  data: Uint8Array,
): Promise<Response> {
  return instance.fetch(
    new Request(`${ORIGIN}/api/plugins/upload?filename=installable-1.0.0.tgz`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${user.token}`,
        "content-type": "application/gzip",
      },
      body: data,
    }),
  );
}

async function setUpSpace(api: Client) {
  const { org } = await api.json<{ org: { id: string } }>("POST", "/api/orgs", {
    slug: "acme",
    name: "Acme",
  });
  const { space } = await api.json<{ space: { id: string } }>(
    "POST",
    `/api/orgs/${org.id}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  return { orgId: org.id, space: `/api/orgs/${org.id}/spaces/${space.id}` };
}

async function editorsOf(api: Client, space: string) {
  const { editors } = await api.json<{
    editors: { name: string; url: string }[];
  }>("GET", `${space}/frontend`);
  return editors;
}

function stamp(instance: Instance): string {
  return instance.ctx.render.render({
    id: "stamp",
    type: "test.stamp",
    v: 1,
    attrs: { label: "<hi>" },
  }).html;
}

describe("plugin installation", () => {
  it.each([true, false])(
    "checks the lease after runtime storage replacement (same database: %s)",
    async (sameDatabase) => {
      const { instance, admin, dataDir, configFile } = await bootData();
      const previousConfig = existsSync(configFile)
        ? readFileSync(configFile, "utf8")
        : undefined;
      const files = installable();
      const manifest = JSON.parse(
        files["docleus.plugin.json"] ?? "{}",
      ) as Record<string, unknown>;
      files["docleus.plugin.json"] = JSON.stringify({
        ...manifest,
        provides: ["storage"],
      });
      const storageModule = fileURLToPath(
        new URL("../../core-storage/src/index.ts", import.meta.url),
      );
      files["server/index.js"] = `
      import { definePlugin } from "@docleus/sdk";
      import { createStorageService } from ${JSON.stringify(storageModule)};
      export const plugin = definePlugin({
        name: "@test/installable", inject: [],
        apply(ctx) {
          ctx.provide("storage", createStorageService(ctx, ${JSON.stringify(join(dataDir, sameDatabase ? "docleus.db" : "unrelated.db"))}));
        }
      });
    `;

      const response = await upload(instance, admin, npmPack(files));
      if (!sameDatabase) {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "plugin/install-lease-lost",
        });
        expect(
          existsSync(configFile) ? readFileSync(configFile, "utf8") : undefined,
        ).toBe(previousConfig);
        expect(await instance.ctx.installations.isInstalled(NAME)).toBe(false);
        expect(existsSync(installedDir(dataDir))).toBe(true);
        return;
      }
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await instance.ctx.installations.isInstalled(NAME)).toBe(true);
      expect(parse(readFileSync(configFile, "utf8"))).toMatchObject({
        plugins: [{ id: NAME }],
      });
      expect(
        (await admin.api.call("DELETE", `/api/plugins/${ENCODED}`)).status,
      ).toBe(204);
      expect(await instance.ctx.installations.isInstalled(NAME)).toBe(false);
      expect(parse(readFileSync(configFile, "utf8"))).toEqual({ plugins: [] });
    },
  );

  it.each([false, true])(
    "stops after a takeover during plugin apply (replacement: %s)",
    async (replacement) => {
      const { instance, admin, dataDir, configFile } = await bootData();
      if (replacement) {
        expect(
          (await upload(instance, admin, npmPack(installable()))).status,
        ).toBe(201);
      }
      const previousDir = replacement ? installedDir(dataDir) : undefined;
      const previousConfig = existsSync(configFile)
        ? readFileSync(configFile, "utf8")
        : "plugins: []\n";
      const currentConfig =
        previousConfig + "publicUrl: https://other-owner.test\n";
      const files = restyled("takeover");
      files["server/index.js"] =
        'import { writeFileSync } from "node:fs";\n' +
        (files["server/index.js"] ?? "")
          .replace(
            'inject: ["blocks", "render"]',
            'inject: ["blocks", "render", "storage"]',
          )
          .replace(
            "apply(ctx) {",
            `async apply(ctx) {
              await ctx.storage.db.updateTable("plugin_install_lock")
                .set({ holder: "other-holder" }).where("key", "=", "plugins").execute();
              writeFileSync(${JSON.stringify(configFile)}, ${JSON.stringify(currentConfig)});`,
          );

      const response = await upload(instance, admin, npmPack(files));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "plugin/install-lease-lost",
      });
      expect(readFileSync(configFile, "utf8")).toBe(currentConfig);
      expect(await instance.ctx.installations.isInstalled(NAME)).toBe(
        replacement,
      );
      expect(
        readdirSync(join(dataDir, "plugins")).filter(
          (dir) => dir !== "node_modules",
        ),
      ).toHaveLength(replacement ? 2 : 1);
      if (previousDir) expect(existsSync(previousDir)).toBe(true);
      const result = await sql<{ holder: string }>`
        SELECT holder FROM plugin_install_lock WHERE key = 'plugins'
      `.execute(instance.ctx.storage.db);
      expect(result.rows).toEqual([{ holder: "other-holder" }]);
    },
  );

  it("stops an uninstall after takeover without restoring stale config or deleting files and settings", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    const currentConfig = "publicUrl: https://other-owner.test\nplugins: []\n";
    const files = installable();
    files["server/index.js"] =
      'import { writeFileSync } from "node:fs";\n' +
      (files["server/index.js"] ?? "")
        .replace(
          'inject: ["blocks", "render"]',
          'inject: ["blocks", "render", "storage"]',
        )
        .replace(
          "apply(ctx) {",
          `apply(ctx) {
            const db = ctx.storage.db;
            ctx.effect(() => async () => {
              await db.updateTable("plugin_install_lock")
                .set({ holder: "other-holder" }).where("key", "=", "plugins").execute();
              writeFileSync(${JSON.stringify(configFile)}, ${JSON.stringify(currentConfig)});
            });`,
        );
    expect((await upload(instance, admin, npmPack(files))).status).toBe(201);
    const previousDir = installedDir(dataDir);
    const org = await instance.ctx.content.createOrg({
      slug: "acme",
      name: "Acme",
    });
    const scope = { kind: "org", orgId: org.id } as const;
    await instance.ctx.installations.setEnabled(NAME, scope, true);
    await instance.ctx.installations.setSettings(NAME, scope, {
      greeting: "keep",
    });

    const response = await admin.api.call("DELETE", `/api/plugins/${ENCODED}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "plugin/install-lease-lost",
    });
    expect(readFileSync(configFile, "utf8")).toBe(currentConfig);
    expect(existsSync(previousDir)).toBe(true);
    expect(await instance.ctx.installations.isInstalled(NAME)).toBe(true);
    expect(await instance.ctx.installations.isEnabled(NAME, scope)).toBe(true);
    expect(await instance.ctx.installations.getSettings(NAME, scope)).toEqual({
      greeting: "keep",
    });
  });

  it("restores the runtime and deployment after recording an install fails", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    await sql
      .raw(
        "CREATE TRIGGER fail_install BEFORE INSERT ON installations WHEN NEW.plugin = '@test/installable' BEGIN SELECT RAISE(FAIL, 'injected installation failure'); END",
      )
      .execute(instance.ctx.storage.db);

    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      500,
    );
    expect(instance.plugins.has(NAME)).toBe(false);
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(false);
    expect(await instance.ctx.installations.isInstalled(NAME)).toBe(false);
    expect(parse(readFileSync(configFile, "utf8"))).toEqual({ plugins: [] });
    expect(readdirSync(join(dataDir, "plugins"))).toEqual(["node_modules"]);

    await sql.raw("DROP TRIGGER fail_install").execute(instance.ctx.storage.db);
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    await instance.dispose();
    instances.splice(instances.indexOf(instance), 1);
    const restarted = await boot({ dataDir, configFile });
    expect(restarted.plugins.has(NAME)).toBe(true);
    expect(stamp(restarted)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');
  });

  it("keeps the previous plugin and files after recording a replacement fails", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    const previousDir = installedDir(dataDir);
    const previousConfig = readFileSync(configFile, "utf8");
    await sql
      .raw(
        "CREATE TRIGGER fail_install BEFORE INSERT ON installations WHEN NEW.plugin = '@test/installable' BEGIN SELECT RAISE(FAIL, 'injected replacement failure'); END",
      )
      .execute(instance.ctx.storage.db);

    expect(
      (await upload(instance, admin, npmPack(restyled("replacement")))).status,
    ).toBe(500);
    expect(stamp(instance)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');
    expect(instance.plugins.get(NAME)?.dir).toBe(previousDir);
    expect(installedDir(dataDir)).toBe(previousDir);
    expect(readFileSync(configFile, "utf8")).toBe(previousConfig);
    expect(await instance.ctx.installations.isInstalled(NAME)).toBe(true);
  });

  it("restores an uninstall whose database transaction fails without losing settings", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    const org = await instance.ctx.content.createOrg({
      slug: "acme",
      name: "Acme",
    });
    const scope = { kind: "org", orgId: org.id } as const;
    await instance.ctx.installations.setEnabled(NAME, scope, true);
    await instance.ctx.installations.setSettings(NAME, scope, {
      greeting: "keep",
    });
    const previousConfig = readFileSync(configFile, "utf8");
    const previousDir = installedDir(dataDir);
    await sql
      .raw(
        "CREATE TRIGGER fail_uninstall BEFORE DELETE ON installations WHEN OLD.plugin = '@test/installable' BEGIN SELECT RAISE(FAIL, 'injected uninstall failure'); END",
      )
      .execute(instance.ctx.storage.db);

    expect(
      (await admin.api.call("DELETE", `/api/plugins/${ENCODED}`)).status,
    ).toBe(500);
    expect(instance.plugins.has(NAME)).toBe(true);
    expect(stamp(instance)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');
    expect(readFileSync(configFile, "utf8")).toBe(previousConfig);
    expect(installedDir(dataDir)).toBe(previousDir);
    expect(await instance.ctx.installations.isInstalled(NAME)).toBe(true);
    expect(await instance.ctx.installations.isEnabled(NAME, scope)).toBe(true);
    expect(await instance.ctx.installations.getSettings(NAME, scope)).toEqual({
      greeting: "keep",
    });

    await sql
      .raw("DROP TRIGGER fail_uninstall")
      .execute(instance.ctx.storage.db);
    expect(
      (await admin.api.call("DELETE", `/api/plugins/${ENCODED}`)).status,
    ).toBe(204);
    expect(existsSync(previousDir)).toBe(false);
  });

  it("restores the fresh deployment from another process after a failed install", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    const second = await boot({ dataDir, configFile, role: "web" });
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    const previousConfig = readFileSync(configFile, "utf8");
    const previousDir = installedDir(dataDir);
    await sql
      .raw(
        "CREATE TRIGGER fail_second BEFORE INSERT ON installations WHEN NEW.plugin = '@test/second' BEGIN SELECT RAISE(FAIL, 'injected second installation failure'); END",
      )
      .execute(second.ctx.storage.db);

    expect(
      (await upload(second, admin, npmPack(renamed("@test/second")))).status,
    ).toBe(500);
    expect(second.plugins.has("@test/second")).toBe(false);
    expect(second.plugins.has(NAME)).toBe(true);
    expect(stamp(second)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');
    expect(readFileSync(configFile, "utf8")).toBe(previousConfig);
    expect(installedDir(dataDir)).toBe(previousDir);
  });

  it("retains plugin files when restoring the config also fails", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    const files = installable();
    files["server/index.js"] =
      'import { mkdirSync, rmSync } from "node:fs";\n' +
      (files["server/index.js"] ?? "")
        .replace(
          'inject: ["blocks", "render"]',
          'inject: ["blocks", "render", "installations"]',
        )
        .replace(
          "apply(ctx) {",
          `apply(ctx) {
          const installations = ctx.installations;
          const install = installations.install;
          ctx.effect(() => {
            installations.install = async () => {
              rmSync(${JSON.stringify(configFile)});
              mkdirSync(${JSON.stringify(configFile)});
              throw new Error("injected database and config recovery failure");
            };
            return () => { installations.install = install; };
          });`,
        );

    const response = await upload(instance, admin, npmPack(files));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "plugin/rollback-failed",
    });
    expect(existsSync(join(installedDir(dataDir), "server/index.js"))).toBe(
      true,
    );
  });

  it("installs an uploaded tarball without a restart and uninstalls it", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    const { orgId, space } = await setUpSpace(admin.api);
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(false);

    const response = await upload(instance, admin, npmPack(installable()));
    expect(response.status).toBe(201);
    const { plugin } = (await response.json()) as {
      plugin: Record<string, unknown>;
    };
    expect(plugin).toMatchObject({
      name: NAME,
      version: "1.0.0",
      hasEditor: true,
      isInstalled: true,
      source: { type: "tarball", filename: "installable-1.0.0.tgz" },
    });
    expect(plugin.sha256).toMatch(/^[0-9a-f]{64}$/);

    const { plugins } = await admin.api.json<{
      plugins: { name: string; isInstalled: boolean }[];
    }>("GET", "/api/plugins");
    expect(plugins).toContainEqual(
      expect.objectContaining({ name: NAME, isInstalled: true }),
    );
    expect(plugins).toContainEqual(
      expect.objectContaining({ name: "@test/browser", isInstalled: false }),
    );

    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(true);
    expect(stamp(instance)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');

    const dirName = `@test+installable@1.0.0-${String(plugin.sha256).slice(0, 12)}`;
    const dir = join(dataDir, "plugins", dirName);
    expect(existsSync(join(dir, "server", "index.js"))).toBe(true);
    expect(parse(readFileSync(configFile, "utf8"))).toEqual({
      plugins: [
        {
          id: NAME,
          plugin: `./plugins/${dirName}`,
          version: "1.0.0",
          source: { type: "tarball", filename: "installable-1.0.0.tgz" },
          sha256: plugin.sha256,
        },
      ],
    });

    expect(await editorsOf(admin.api, space)).not.toContainEqual(
      expect.objectContaining({ name: NAME }),
    );
    await admin.api.json("PUT", `/api/orgs/${orgId}/plugins`, {
      plugin: NAME,
      enabled: true,
    });
    const editor = (await editorsOf(admin.api, space)).find(
      (e) => e.name === NAME,
    );
    expect(editor?.url).toBe("/_plugins/%40test%2Finstallable/index.js");
    const served = await instance.fetch(new Request(`${ORIGIN}${editor?.url}`));
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("test.stamp");

    const removed = await admin.api.call("DELETE", `/api/plugins/${ENCODED}`);
    expect(removed.status).toBe(204);
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(false);
    expect(await editorsOf(admin.api, space)).not.toContainEqual(
      expect.objectContaining({ name: NAME }),
    );
    expect(existsSync(dir)).toBe(false);
    expect(parse(readFileSync(configFile, "utf8"))).toEqual({ plugins: [] });
  });

  it("mounts installed plugins again after a restart", async () => {
    const first = await bootData();
    expect(
      (await upload(first.instance, first.admin, npmPack(installable())))
        .status,
    ).toBe(201);
    await first.instance.dispose();
    instances.splice(instances.indexOf(first.instance), 1);

    const instance = await boot({
      dataDir: first.dataDir,
      configFile: first.configFile,
    });
    expect(instance.plugins.has(NAME)).toBe(true);
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(true);
    expect(existsSync(join(first.dataDir, "backups"))).toBe(true);
  });

  it("treats the same tarball as a no-op", async () => {
    const { instance, admin, dataDir } = await bootData();
    const tarball = npmPack(installable());
    expect((await upload(instance, admin, tarball)).status).toBe(201);
    const before = readdirSync(join(dataDir, "plugins"));
    expect((await upload(instance, admin, tarball)).status).toBe(201);
    expect(readdirSync(join(dataDir, "plugins"))).toEqual(before);
  });

  it("runs the new code after reinstalling the same version with other contents", async () => {
    const { instance, admin, dataDir, configFile } = await bootData();
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    expect(stamp(instance)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');

    const response = await upload(instance, admin, npmPack(restyled("v2")));
    expect(response.status).toBe(201);
    expect(stamp(instance)).toBe('<p class="test-stamp-v2">&lt;hi&gt;</p>');
    const installed = readdirSync(join(dataDir, "plugins")).filter(
      (dir) => dir !== "node_modules",
    );
    expect(installed).toHaveLength(1);
    expect(parse(readFileSync(configFile, "utf8"))).toMatchObject({
      plugins: [{ id: NAME, plugin: `./plugins/${installed[0] ?? ""}` }],
    });
  });

  it("runs the new code after uninstalling and installing the same version again", async () => {
    const { instance, admin } = await bootData();
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    expect(stamp(instance)).toBe('<p class="test-stamp">&lt;hi&gt;</p>');
    const removed = await admin.api.call("DELETE", `/api/plugins/${ENCODED}`);
    expect(removed.status).toBe(204);

    expect(
      (await upload(instance, admin, npmPack(restyled("v3")))).status,
    ).toBe(201);
    expect(stamp(instance)).toBe('<p class="test-stamp-v3">&lt;hi&gt;</p>');
  });

  it("replaces an installed plugin with another version", async () => {
    const { instance, admin, dataDir } = await bootData();
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    const files = installable();
    const manifest = JSON.parse(files["docleus.plugin.json"] ?? "{}") as Record<
      string,
      unknown
    >;
    files["docleus.plugin.json"] = JSON.stringify({
      ...manifest,
      version: "1.1.0",
    });
    expect((await upload(instance, admin, npmPack(files))).status).toBe(201);
    expect(instance.plugins.get(NAME)?.manifest.version).toBe("1.1.0");
    const installed = readdirSync(join(dataDir, "plugins")).toSorted();
    expect(installed).toHaveLength(2);
    expect(installed[0]).toMatch(/^@test\+installable@1\.1\.0-[0-9a-f]{12}$/);
    expect(installed[1]).toBe("node_modules");
  });

  it("installs from a server path", async () => {
    const { instance, admin } = await bootData();
    const { plugin } = await admin.api.json<{
      plugin: { source: unknown };
    }>("POST", "/api/plugins", {
      type: "path",
      path: join(fixtures, "installable"),
    });
    expect(plugin.source).toEqual({
      type: "path",
      path: join(fixtures, "installable"),
    });
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(true);
  });

  it("installs from a Git ref", async () => {
    const { repo, commit } = await commitRepo(join(fixtures, "installable"));
    const { instance, admin, dataDir } = await bootData();
    const { plugin } = await admin.api.json<{
      plugin: { source: unknown };
    }>("POST", "/api/plugins", {
      type: "git",
      url: `file://${repo}`,
      ref: "main",
    });
    expect(plugin.source).toEqual({
      type: "git",
      url: `file://${repo}`,
      ref: "main",
      commit,
    });
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(true);
    expect(existsSync(join(installedDir(dataDir), ".git"))).toBe(false);
  });

  it("installs only the production dependencies of a Git ref", async () => {
    // The fixture links dev dependencies from a workspace that does not
    // exist next to the clone, and has a `prepare` script that fails.
    const { repo } = await commitRepo(join(fixtures, "with-deps"));
    const { instance, admin, dataDir } = await bootData();
    const response = await installGit(admin, repo);
    expect(response.status).toBe(201);
    expect(greetingOf(instance)).toBe("<p>hello</p>");
    const dir = installedDir(dataDir);
    expect(existsSync(join(dir, "node_modules", "@test", "greeting"))).toBe(
      true,
    );
    expect(existsSync(join(dir, "node_modules", "@docleus"))).toBe(false);
  });

  it("refuses a Git ref without built files that cannot be built", async () => {
    const { repo } = await commitRepo(join(fixtures, "with-deps"), (dir) =>
      rm(join(dir, "server"), { recursive: true }),
    );
    const { instance, admin, dataDir } = await bootData();
    const response = await installGit(admin, repo);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "plugin/install-failed",
    });
    expect(instance.plugins.has("@test/with-deps")).toBe(false);
    expect(readdirSync(join(dataDir, "plugins"))).toEqual(["node_modules"]);
  });

  it("builds on the config file as another process left it", async () => {
    const dataDir = tempDir("docleus-install-");
    const configFile = join(dataDir, "docleus.yaml");
    const first = await boot({ dataDir, configFile, role: "web" });
    const second = await boot({ dataDir, configFile, role: "web" });
    const admin = await account(first, "admin@example.com", { isAdmin: true });

    expect((await upload(first, admin, npmPack(installable()))).status).toBe(
      201,
    );
    const secondInstall = await upload(
      second,
      admin,
      npmPack(renamed("@test/second")),
    );
    expect(secondInstall.status).toBe(201);

    const { plugins } = parse(readFileSync(configFile, "utf8")) as {
      plugins: { id: string }[];
    };
    expect(plugins.map((row) => row.id).toSorted()).toEqual([
      "@test/installable",
      "@test/second",
    ]);
    expect(second.plugins.has("@test/installable")).toBe(true);
    expect(second.ctx.blocks.isKnown("test.stamp")).toBe(true);
  });

  it("refuses a plugin whose engines range excludes this platform", async () => {
    const { instance, admin, dataDir } = await bootData();
    const files = installable();
    files["docleus.plugin.json"] = JSON.stringify({
      name: NAME,
      version: "1.0.0",
      engines: { docleus: "^9" },
      entries: { server: "./server/index.js" },
    });
    const response = await upload(instance, admin, npmPack(files));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "plugin/engines-mismatch",
    });
    expect(instance.plugins.has(NAME)).toBe(false);
    expect(readdirSync(join(dataDir, "plugins"))).toEqual(["node_modules"]);
  });

  it("refuses a plugin whose browser modules conflict with a mounted plugin's", async () => {
    const { instance, admin, dataDir } = await bootData();
    const files = {
      "docleus.plugin.json": JSON.stringify({
        name: "@test/clash",
        version: "1.0.0",
        engines: { docleus: ">=0.0.1 <0.0.9" },
        entries: { editor: "./editor.js" },
        exposes: { "@test/browser-lib": "./lib.js" },
      }),
      "editor.js": "export {};",
      "lib.js": "export {};",
    };
    const response = await upload(instance, admin, npmPack(files));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "plugin/expose-conflict",
    });
    expect(instance.plugins.has("@test/clash")).toBe(false);
    expect(readdirSync(join(dataDir, "plugins"))).toEqual(["node_modules"]);
  });

  it("refuses a malicious tarball", async () => {
    const { instance, admin } = await bootData();
    const response = await upload(
      instance,
      admin,
      npmPack({ ...installable(), "../escape.js": "x" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "plugin/invalid-tarball",
    });
  });

  it("refuses a plugin that declares a missing entry", async () => {
    const { instance, admin } = await bootData();
    const { "editor/index.js": _editor, ...files } = installable();
    const response = await upload(instance, admin, npmPack(files));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "plugin/install-failed",
    });
  });

  it("refuses bundled plugins and non-admins", async () => {
    const { instance, admin } = await bootData();
    const bundled = await admin.api.call(
      "DELETE",
      `/api/plugins/${encodeURIComponent("@test/browser")}`,
    );
    expect(bundled.status).toBe(409);
    const missing = await admin.api.call("DELETE", `/api/plugins/nope`);
    expect(missing.status).toBe(404);

    const member = await account(instance, "member@example.com");
    expect((await member.api.call("GET", "/api/plugins")).status).toBe(403);
    expect(
      (await upload(instance, member, npmPack(installable()))).status,
    ).toBe(403);
  });

  it("lets the deployment config enable a disabled bundle row", async () => {
    const dataDir = tempDir("docleus-install-");
    const configFile = join(dataDir, "docleus.yaml");
    await writeFile(
      configFile,
      "plugins:\n  - id: stamp\n    disabled: false\n",
    );
    const bundle = [
      { id: "browser", plugin: "browser" },
      { id: "stamp", plugin: "installable", disabled: true },
    ];
    const disabled = await boot({ dataDir, plugins: bundle });
    expect(disabled.plugins.has(NAME)).toBe(false);
    await disabled.dispose();
    instances.splice(instances.indexOf(disabled), 1);

    const enabled = await boot({ dataDir, configFile, plugins: bundle });
    expect(enabled.plugins.has(NAME)).toBe(true);
    expect(enabled.ctx.blocks.isKnown("test.stamp")).toBe(true);
  });

  it("keeps installs in memory without a config file", async () => {
    const instance = await boot();
    const admin = await account(instance, "admin@example.com", {
      isAdmin: true,
    });
    expect((await upload(instance, admin, npmPack(installable()))).status).toBe(
      201,
    );
    expect(instance.ctx.blocks.isKnown("test.stamp")).toBe(true);
  });

  it("drops a host module a tarball ships", async () => {
    const { instance, admin, dataDir } = await bootData();
    const response = await upload(
      instance,
      admin,
      npmPack({
        ...installable(),
        "node_modules/@docleus/sdk/package.json": "{}",
        "node_modules/@docleus/sdk/index.js": "throw new Error('shadowed')",
      }),
    );
    expect(response.status).toBe(201);
    expect(
      existsSync(
        join(installedDir(dataDir), "node_modules", "@docleus", "sdk"),
      ),
    ).toBe(false);
  });
});

// Two connections to one SQLite file in one process would wait on each
// other's write lock; processes that install at the same time share Postgres.
describe.skipIf(testStorageDialect() !== "postgres")(
  "plugin installation on a shared database",
  () => {
    it("serializes installs of processes that share a database and config file", async () => {
      const dataDir = tempDir("docleus-install-");
      const configFile = join(dataDir, "docleus.yaml");
      const database = await testStorageLocation();
      const first = await boot({ dataDir, configFile, role: "web", database });
      const second = await boot({ dataDir, configFile, role: "web", database });
      const admin = await account(first, "admin@example.com", {
        isAdmin: true,
      });

      const [stamped, secondInstall] = await Promise.all([
        upload(first, admin, npmPack(installable())),
        upload(second, admin, npmPack(renamed("@test/second"))),
      ]);
      expect(stamped.status).toBe(201);
      expect(secondInstall.status).toBe(201);

      const { plugins } = parse(readFileSync(configFile, "utf8")) as {
        plugins: { id: string }[];
      };
      expect(plugins.map((row) => row.id).toSorted()).toEqual([
        "@test/installable",
        "@test/second",
      ]);
      await expect(
        first.ctx.storage.db
          .selectFrom("plugin_install_lock" as never)
          .selectAll()
          .execute(),
      ).resolves.toEqual([]);
    });
  },
);
