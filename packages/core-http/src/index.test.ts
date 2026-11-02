import { Context, type Fiber } from "@docleus/kernel";
import { createAuthzService } from "@docleus/core-authz";
import { createIdentityService } from "@docleus/core-identity";
import { createStorageService } from "@docleus/core-storage";
import {
  httpConformanceSuite,
  runConformanceSuite,
  type HttpConformanceSubject,
} from "@docleus/conformance";
import { testStorageLocation } from "@docleus/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpService, type HttpServiceOptions } from "./index.ts";
import {
  SESSION_COOKIE,
  type HttpService,
  type IdentityService,
} from "@docleus/sdk";

const fibers: Fiber[] = [];

async function fresh(
  options?: HttpServiceOptions,
): Promise<{ http: HttpService; identity: IdentityService }> {
  let http!: HttpService;
  let identity!: IdentityService;
  const storageLocation = await testStorageLocation();
  const fiber = await new Context().plugin((ctx: Context) => {
    ctx.provide("storage", createStorageService(ctx, storageLocation));
    identity = createIdentityService(ctx);
    ctx.provide("identity", identity);
    ctx.provide("authz", createAuthzService(ctx));
    http = createHttpService(ctx, options);
  });
  fibers.push(fiber);
  return { http, identity };
}

async function freshSubject(): Promise<HttpConformanceSubject> {
  const { http, identity } = await fresh();
  let counter = 0;
  return {
    http,
    async signIn() {
      counter += 1;
      const user = await identity.createUser({
        email: `user${counter}@example.com`,
        name: `User ${counter}`,
      });
      return { token: await identity.createSession(user.id), userId: user.id };
    },
  };
}

afterEach(async () => {
  await Promise.all(fibers.splice(0).map((fiber) => fiber.dispose()));
});

runConformanceSuite(httpConformanceSuite, freshSubject);

describe("createHttpService", () => {
  it("answers its own 401 and 403 with a JSON error code", async () => {
    const { http, signIn } = await freshSubject();
    const { token } = await signIn();
    http.route("GET", "/private", () => new Response("ok"));
    http.route("POST", "/act", () => new Response("ok"));
    http.route("GET", "/admin", () => new Response("ok"), {
      authorize: { action: "manage", resource: { kind: "instance" } },
    });
    const unauthorized = await http.fetch(
      new Request("http://localhost/private"),
    );
    expect(await unauthorized.json()).toMatchObject({
      code: "http/unauthorized",
    });
    const crossSite = await http.fetch(
      new Request("http://localhost/act", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: "https://evil.example",
        },
      }),
    );
    expect(await crossSite.json()).toMatchObject({
      code: "http/cross-site-request",
    });
    const forbidden = await http.fetch(
      new Request("http://localhost/admin", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(await forbidden.json()).toMatchObject({ code: "http/forbidden" });
  });

  it("does not fall back to the cookie when the bearer token is invalid", async () => {
    const { http, signIn } = await freshSubject();
    const { token } = await signIn();
    http.route("GET", "/private", () => new Response("ok"));
    const response = await http.fetch(
      new Request("http://localhost/private", {
        headers: {
          authorization: "Bearer no-such-token",
          cookie: `${SESSION_COOKIE}=${token}`,
        },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a session token that cannot be a cookie value", async () => {
    const { http } = await fresh();
    expect(() =>
      http.sessionCookie(new Request("http://localhost/"), "a; Domain=evil"),
    ).toThrow(expect.objectContaining({ code: "http/invalid-cookie-value" }));
  });

  it("ignores forwarded headers unless the proxy is trusted", async () => {
    const forwarded = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "docs.example.com",
      "x-forwarded-for": "203.0.113.5, 10.0.0.1",
    };
    const behindProxy = () =>
      new Request("http://internal:3000/ip", { headers: forwarded });

    const direct = await fresh();
    direct.http.route(
      "GET",
      "/ip",
      ({ clientAddress }) => Response.json(clientAddress ?? null),
      { public: true },
    );
    const directIp = await direct.http.fetch(behindProxy(), {
      clientAddress: "10.0.0.1",
    });
    expect(await directIp.json()).toBe("10.0.0.1");
    expect(direct.http.sessionCookie(behindProxy(), "t")).not.toContain(
      "Secure",
    );

    const proxied = await fresh({ trustProxy: true });
    proxied.http.route(
      "GET",
      "/ip",
      ({ clientAddress }) => Response.json(clientAddress ?? null),
      { public: true },
    );
    const proxiedIp = await proxied.http.fetch(behindProxy(), {
      clientAddress: "10.0.0.1",
    });
    expect(await proxiedIp.json()).toBe("203.0.113.5");
    expect(proxied.http.sessionCookie(behindProxy(), "t")).toContain("Secure");
    const withoutForwardedFor = await proxied.http.fetch(
      new Request("http://internal:3000/ip"),
      { clientAddress: "10.0.0.1" },
    );
    expect(await withoutForwardedFor.json()).toBe("10.0.0.1");
  });

  it("compares Origin with the forwarded origin when the proxy is trusted", async () => {
    const { http, identity } = await fresh({ trustProxy: true });
    const user = await identity.createUser({
      email: "p@example.com",
      name: "P",
    });
    const token = await identity.createSession(user.id);
    http.route("POST", "/act", () => new Response("ok"));
    const post = (origin: string) =>
      http.fetch(
        new Request("http://internal:3000/act", {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE}=${token}`,
            origin,
            "x-forwarded-proto": "https",
            "x-forwarded-host": "docs.example.com",
          },
        }),
      );
    expect((await post("https://docs.example.com")).status).toBe(200);
    expect((await post("http://internal:3000")).status).toBe(403);
  });

  it("sets the cookie's Max-Age to the default session lifetime", async () => {
    const { http } = await fresh();
    expect(http.sessionCookie(new Request("http://localhost/"), "t")).toBe(
      `${SESSION_COOKIE}=t; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
  });

  it("swaps the router atomically: an in-flight fetch sees a consistent route set", async () => {
    const { http } = await fresh();
    http.route("GET", "/a", () => new Response("a"), { public: true });
    const responseA = await http.fetch(new Request("http://localhost/a"));

    http.route("GET", "/b", () => new Response("b"), { public: true });

    expect(await responseA.text()).toBe("a");
    expect(
      await (await http.fetch(new Request("http://localhost/b"))).text(),
    ).toBe("b");
  });
});

function fakeSocket() {
  return {
    written: "",
    isDestroyed: false,
    write(data: string) {
      this.written += data;
      return true;
    },
    destroy() {
      this.isDestroyed = true;
    },
  };
}

function upgradeRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
  });
}

describe("upgrade", () => {
  it("hands an authenticated upgrade with the raw socket to its handler", async () => {
    const { http, signIn } = await freshSubject();
    const { token, userId } = await signIn();
    const seen: unknown[] = [];
    http.upgrade("/live", (context) => {
      seen.push(context.actor, context.socket, context.head, context.incoming);
    });
    const socket = fakeSocket();
    await http.handleUpgrade(
      upgradeRequest("/live?doc=1", {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: "http://localhost",
      }),
      { incoming: "incoming", socket, head: "head" },
    );
    expect(seen).toEqual([
      { kind: "user", userId },
      socket,
      "head",
      "incoming",
    ]);
    expect(socket.written).toBe("");
    expect(socket.isDestroyed).toBe(false);
  });

  it("answers 404 on the socket when no handler takes the path", async () => {
    const { http } = await freshSubject();
    const socket = fakeSocket();
    await http.handleUpgrade(upgradeRequest("/nothing"), {
      incoming: undefined,
      socket,
      head: undefined,
    });
    expect(socket.written).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    expect(socket.written).toContain('"code":"http/not-found"');
    expect(socket.isDestroyed).toBe(true);
  });

  it("answers 401 to an anonymous upgrade unless the handler is public", async () => {
    const { http } = await freshSubject();
    let calls = 0;
    http.upgrade("/private", () => {
      calls += 1;
    });
    http.upgrade(
      "/open",
      () => {
        calls += 10;
      },
      { public: true },
    );
    const refused = fakeSocket();
    await http.handleUpgrade(upgradeRequest("/private"), {
      incoming: undefined,
      socket: refused,
      head: undefined,
    });
    expect(refused.written).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(refused.isDestroyed).toBe(true);
    const open = fakeSocket();
    await http.handleUpgrade(upgradeRequest("/open"), {
      incoming: undefined,
      socket: open,
      head: undefined,
    });
    expect(open.isDestroyed).toBe(false);
    expect(calls).toBe(10);
  });

  it("rejects a cookie upgrade from another site, as for unsafe methods", async () => {
    const { http, signIn } = await freshSubject();
    const { token } = await signIn();
    let calls = 0;
    http.upgrade("/live", () => {
      calls += 1;
    });
    for (const headers of [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[]) {
      const socket = fakeSocket();
      await http.handleUpgrade(
        upgradeRequest("/live", {
          cookie: `${SESSION_COOKIE}=${token}`,
          ...headers,
        }),
        { incoming: undefined, socket, head: undefined },
      );
      expect(socket.written).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
      expect(socket.written).toContain("http/cross-site-request");
      expect(socket.isDestroyed).toBe(true);
    }
    const bearer = fakeSocket();
    await http.handleUpgrade(
      upgradeRequest("/live", {
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      }),
      { incoming: undefined, socket: bearer, head: undefined },
    );
    expect(bearer.isDestroyed).toBe(false);
    expect(calls).toBe(1);
  });

  it("applies authorize before calling the handler", async () => {
    const { http, signIn } = await freshSubject();
    const { token } = await signIn();
    let calls = 0;
    http.upgrade(
      "/admin",
      () => {
        calls += 1;
      },
      { authorize: { action: "manage", resource: { kind: "instance" } } },
    );
    const socket = fakeSocket();
    await http.handleUpgrade(
      upgradeRequest("/admin", { authorization: `Bearer ${token}` }),
      { incoming: undefined, socket, head: undefined },
    );
    expect(socket.written).toContain("http/forbidden");
    expect(socket.isDestroyed).toBe(true);
    expect(calls).toBe(0);
  });

  it("throws when the path is taken and frees it when removed", async () => {
    const { http } = await freshSubject();
    const remove = http.upgrade("/live", () => {});
    expect(() => http.upgrade("/live", () => {})).toThrow(
      expect.objectContaining({ code: "http/already-registered" }),
    );
    remove();
    const socket = fakeSocket();
    await http.handleUpgrade(upgradeRequest("/live"), {
      incoming: undefined,
      socket,
      head: undefined,
    });
    expect(socket.written).toMatch(/^HTTP\/1\.1 404/);
    expect(() => http.upgrade("/live", () => {})).not.toThrow();
  });

  it("rejects options that are both public and authorized", async () => {
    const { http } = await freshSubject();
    expect(() =>
      http.upgrade("/live", () => {}, {
        public: true,
        authorize: { action: "read", resource: { kind: "instance" } },
      }),
    ).toThrow(expect.objectContaining({ code: "http/invalid-options" }));
  });
});
