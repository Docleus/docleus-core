import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Context } from "@docleus/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { listen, type Instance, type Listening } from "../src/index.ts";
import { account, bootWith } from "./helpers.ts";

const instances: Instance[] = [];
const servers: Listening[] = [];
const sockets: Socket[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

type Outcome =
  | { readonly kind: "upgraded"; readonly socket: Duplex }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly body: string;
    };

function upgrade(
  url: string,
  headers: Record<string, string> = {},
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      headers: { connection: "Upgrade", upgrade: "echo", ...headers },
    });
    request.on("upgrade", (_response, socket) => {
      resolve({ kind: "upgraded", socket });
    });
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ kind: "refused", status: response.statusCode ?? 0, body }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

function echoUpgrade(ctx: Context, seen: string[]) {
  ctx.http.upgrade("/api/echo", ({ socket, actor, request }) => {
    if (!isDuplex(socket)) throw new Error("expected a socket");
    seen.push(
      `${actor.kind === "user" ? actor.userId : "anonymous"} ${new URL(request.url).search}`,
    );
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(data));
  });
}

function isDuplex(value: unknown): value is Duplex {
  return typeof value === "object" && value !== null && "pipe" in value;
}

function readOnce(socket: Duplex): Promise<string> {
  return new Promise((resolve) =>
    socket.once("data", (data: Buffer) => resolve(data.toString())),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function served() {
  const instance = await boot();
  const seen: string[] = [];
  await instance.ctx.plugin({
    name: "echo",
    inject: ["http"],
    apply: (ctx: Context) => echoUpgrade(ctx, seen),
  });
  const server = await listen(instance, { port: 0 });
  servers.push(server);
  return { instance, server, seen };
}

describe("listen", () => {
  it("hands an authenticated upgrade to the registered handler", async () => {
    const { instance, server, seen } = await served();
    const ada = await account(instance, "ada@example.com");
    const outcome = await upgrade(`${server.url}/api/echo?doc=1`, {
      authorization: `Bearer ${ada.token}`,
    });
    if (outcome.kind !== "upgraded") throw new Error("expected an upgrade");
    outcome.socket.write("ping");
    expect(await readOnce(outcome.socket)).toBe("ping");
    expect(seen).toEqual([`${ada.id} ?doc=1`]);
    outcome.socket.destroy();
  });

  it("answers refused upgrades with an HTTP status and closes the socket", async () => {
    const { server, seen } = await served();
    const anonymous = await upgrade(`${server.url}/api/echo`);
    expect(anonymous).toMatchObject({ kind: "refused", status: 401 });
    const unknown = await upgrade(`${server.url}/api/nothing`);
    expect(unknown).toMatchObject({ kind: "refused", status: 404 });
    expect(seen).toEqual([]);
  });

  it("never upgrades on a site's domain", async () => {
    const { instance, server, seen } = await served();
    const ada = await account(instance, "ada@example.com");
    const org = await instance.ctx.content.createOrg({
      slug: "acme",
      name: "Acme",
    });
    const space = await instance.ctx.content.createSpace({
      orgId: org.id,
      slug: "docs",
      name: "Docs",
    });
    await instance.ctx.sites.create({
      orgId: org.id,
      slug: "docs",
      name: "Docs",
      domain: "docs.example.com",
      spaces: [{ spaceId: space.id, path: "" }],
    });
    const outcome = await upgrade(`${server.url}/api/echo`, {
      host: "docs.example.com",
      authorization: `Bearer ${ada.token}`,
    });
    expect(outcome).toMatchObject({ kind: "refused", status: 404 });
    expect(seen).toEqual([]);
  });

  it("closes upgraded connections when the server closes", async () => {
    const { instance, server } = await served();
    const ada = await account(instance, "ada@example.com");
    const outcome = await upgrade(`${server.url}/api/echo`, {
      authorization: `Bearer ${ada.token}`,
    });
    if (outcome.kind !== "upgraded") throw new Error("expected an upgrade");
    const closed = new Promise<void>((resolve) =>
      outcome.socket.once("close", () => resolve()),
    );
    await servers.splice(0)[0]?.close();
    await closed;
  });

  it("closes connections that have not sent an HTTP request", async () => {
    const { server } = await served();
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(server.url).port),
    });
    sockets.push(socket);
    await once(socket, "connect");
    const response = await fetch(`${server.url}/api/auth/methods`);
    await response.arrayBuffer();
    const closed = once(socket, "close");
    servers.splice(servers.indexOf(server), 1);
    await server.close();
    await closed;
  });

  it("finishes an active HTTP response while closing unused connections", async () => {
    const { instance, server } = await served();
    const started = deferred();
    const release = deferred();
    instance.ctx.http.route(
      "GET",
      "/api/slow",
      async () => {
        started.resolve();
        await release.promise;
        return new Response("completed");
      },
      { public: true },
    );
    const response = fetch(`${server.url}/api/slow`);
    await started.promise;
    const socket = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(server.url).port),
    });
    sockets.push(socket);
    await once(socket, "connect");
    const ready = await fetch(`${server.url}/api/auth/methods`);
    await ready.arrayBuffer();
    const closed = once(socket, "close");
    servers.splice(servers.indexOf(server), 1);
    const closing = server.close();
    try {
      await closed;
    } finally {
      release.resolve();
    }
    expect(await (await response).text()).toBe("completed");
    await closing;
  });

  it("finishes the HTTP request that initiates shutdown", async () => {
    const { instance, server } = await served();
    let closing: Promise<void> | undefined;
    instance.ctx.http.route(
      "GET",
      "/api/stop",
      () => {
        servers.splice(servers.indexOf(server), 1);
        closing = server.close();
        return new Response("completed");
      },
      { public: true },
    );
    const response = await fetch(`${server.url}/api/stop`);
    expect(await response.text()).toBe("completed");
    await closing;
  });
});
