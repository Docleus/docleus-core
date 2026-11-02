import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { serve, type Served } from "../src/index.ts";

const fixtures = fileURLToPath(
  new URL("../../server/tests/fixtures/", import.meta.url),
);
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
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

describe("docleus serve", () => {
  it("serves an instance with the development login over HTTP", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const { out, io: streams } = io();
    const served = await serve(
      ["--port", "0", "--data", data, "--app", `${fixtures}app`, "--dev"],
      streams,
    );
    if (typeof served === "number") throw new Error(out.stderr);
    cleanup.push(() => (served as Served).dispose());

    expect(out.stdout).toContain(served.url);
    expect(out.stderr).toContain("--dev");
    const methods = await fetch(`${served.url}/api/auth/methods`);
    expect(await methods.json()).toEqual({
      password: true,
      dev: true,
      providers: [],
      setupRequired: false,
    });
    expect(out.stdout).not.toContain("setup token");
    const shell = await fetch(`${served.url}/`, {
      headers: { accept: "text/html" },
    });
    expect(await shell.text()).toContain("importmap");
  });

  it("prints the setup token of a new instance and honours the proxy options", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const { out, io: streams } = io();
    const served = await serve(
      [
        "--port",
        "0",
        "--data",
        data,
        "--app",
        `${fixtures}app`,
        "--trust-proxy",
      ],
      streams,
      {},
    );
    if (typeof served === "number") throw new Error(out.stderr);
    cleanup.push(() => (served as Served).dispose());

    const printed = /open (\S+)\/setup and enter the setup token (\S+)/.exec(
      out.stdout,
    );
    expect(printed?.[1]).toBe(served.url.replace(/\/+$/, ""));
    const token = printed?.[2] ?? "";
    const setup = await fetch(`${served.url}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        email: "ada@example.com",
        name: "Ada",
        password: "correct horse",
      }),
    });
    expect(setup.status).toBe(201);
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const proxied = {
      cookie,
      "x-forwarded-proto": "https",
      "x-forwarded-host": "docs.example.com",
    };
    const created = await fetch(`${served.url}/api/orgs`, {
      method: "POST",
      headers: { ...proxied, "content-type": "application/json" },
      body: JSON.stringify({ slug: "acme", name: "Acme" }),
    });
    const { org } = (await created.json()) as { org: { id: string } };
    const invited = await fetch(
      `${served.url}/api/orgs/${org.id}/invitations`,
      {
        method: "POST",
        headers: { ...proxied, "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      },
    );
    expect(invited.status).toBe(201);
    expect(((await invited.json()) as { url: string }).url).toMatch(
      /^https:\/\/docs\.example\.com\/invitations\//,
    );
  });

  it("uses --public-url in the setup hint", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const { out, io: streams } = io();
    const served = await serve(
      [
        "--port",
        "0",
        "--data",
        data,
        "--public-url",
        "https://docs.example.com/",
      ],
      streams,
      {},
    );
    if (typeof served === "number") throw new Error(out.stderr);
    cleanup.push(() => (served as Served).dispose());
    expect(out.stdout).toContain(
      "open https://docs.example.com/setup and enter",
    );
  });

  it("rejects a bad public URL or half an SMTP configuration with exit code 2", async () => {
    const { out, io: streams } = io();
    expect(await serve(["--public-url", "docs.example.com"], streams, {})).toBe(
      2,
    );
    expect(
      await serve([], streams, { DOCLEUS_SMTP_URL: "smtp://localhost:2525" }),
    ).toBe(2);
    expect(out.stderr).toContain("DOCLEUS_SMTP_FROM");
  });

  it("reads the deployment config and lets flags override it", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const configFile = join(data, "deploy.yaml");
    await writeFile(
      configFile,
      [
        "# deployment",
        "data: ./state",
        "database: ./main.db",
        "port: 1",
        "publicUrl: https://docs.example.com",
        `app: ${fixtures}app`,
        "plugins: []",
        "",
      ].join("\n"),
    );
    const { out, io: streams } = io();
    const served = await serve(
      ["--config", configFile, "--port", "0", "--dev"],
      streams,
      {},
    );
    if (typeof served === "number") throw new Error(out.stderr);
    cleanup.push(() => (served as Served).dispose());

    expect(served.url).not.toContain(":1/");
    expect(existsSync(join(data, "main.db"))).toBe(true);
    expect(existsSync(join(data, "state", "plugins"))).toBe(true);
    const { token } = (await (
      await fetch(`${served.url}/api/auth/dev-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com" }),
      })
    ).json()) as { token: string };
    const listed = await fetch(`${served.url}/api/plugins`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await listed.json()).toEqual({ plugins: [] });
    expect(readFileSync(configFile, "utf8")).toContain("# deployment");
  });

  it("takes the database from --database, then the config, then DOCLEUS_DATABASE_URL", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const { out, io: streams } = io();
    const fromEnv = await serve(["--port", "0", "--data", data], streams, {
      DOCLEUS_DATABASE_URL: join(data, "env.db"),
    });
    if (typeof fromEnv === "number") throw new Error(out.stderr);
    await fromEnv.dispose();
    expect(existsSync(join(data, "env.db"))).toBe(true);
    expect(existsSync(join(data, "docleus.db"))).toBe(false);

    const fromFlag = await serve(
      ["--port", "0", "--data", data, "--database", join(data, "flag.db")],
      streams,
      { DOCLEUS_DATABASE_URL: join(data, "env.db") },
    );
    if (typeof fromFlag === "number") throw new Error(out.stderr);
    await fromFlag.dispose();
    expect(existsSync(join(data, "flag.db"))).toBe(true);
  });

  it("runs a worker without an HTTP listener", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const { out, io: streams } = io();
    const served = await serve(
      ["--data", data, "--role", "worker"],
      streams,
      {},
    );
    if (typeof served === "number") throw new Error(out.stderr);
    cleanup.push(() => (served as Served).dispose());
    expect(served.url).toBe("");
    expect(out.stdout).toContain("worker");
    expect(out.stdout).not.toContain("setup token");
  });

  it("rejects a bad role or an invalid config file with exit code 2", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const { out, io: streams } = io();
    expect(await serve(["--role", "cron"], streams, {})).toBe(2);
    expect(out.stderr).toContain("--role");
    await writeFile(join(data, "docleus.yaml"), "colour: blue\n");
    expect(await serve(["--data", data], streams, {})).toBe(2);
    expect(out.stderr).toContain("colour");
  });

  it("signs blob URLs with DOCLEUS_BLOB_SECRET, shared by web and worker", async () => {
    const data = await mkdtemp(join(tmpdir(), "docleus-serve-"));
    cleanup.push(() => rm(data, { recursive: true, force: true }));
    const env = { DOCLEUS_BLOB_SECRET: "s".repeat(32) };
    const { out, io: streams } = io();
    const web = await serve(
      ["--data", join(data, "web"), "--port", "0", "--role", "web"],
      streams,
      env,
    );
    if (typeof web === "number") throw new Error(out.stderr);
    cleanup.push(() => (web as Served).dispose());
    const worker = await serve(
      ["--data", join(data, "worker"), "--role", "worker"],
      streams,
      env,
    );
    if (typeof worker === "number") throw new Error(out.stderr);
    cleanup.push(() => (worker as Served).dispose());
    const hash = "b".repeat(64);
    const token = web.instance.ctx.blobs.sign(hash, Date.now() + 60_000);
    expect(worker.instance.ctx.blobs.verify(token)).toBe(hash);
    expect(existsSync(join(data, "web", "blob-secret"))).toBe(false);
  });

  it("rejects a DOCLEUS_BLOB_SECRET shorter than 32 characters with exit code 2", async () => {
    const { out, io: streams } = io();
    expect(
      await serve(["--port", "0"], streams, { DOCLEUS_BLOB_SECRET: "short" }),
    ).toBe(2);
    expect(out.stderr).toContain("DOCLEUS_BLOB_SECRET");
  });

  it("rejects a bad port with exit code 2", async () => {
    const { io: streams } = io();
    expect(await serve(["--port", "x"], streams)).toBe(2);
  });
});
