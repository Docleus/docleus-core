import {
  SESSION_COOKIE,
  type Actor,
  type HttpService,
  type RouteHandler,
  type RouteInfo,
  type RouteOptions,
  type UpgradeHandler,
} from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { httpConformanceSuite, type HttpConformanceSubject } from "./http.ts";
import { checkInvariant, runConformanceSuite } from "./suite.ts";

type Bug =
  | "everything-public"
  | "bearer-only"
  | "public-is-anonymous"
  | "no-cross-site-check"
  | "origin-only-cross-site-check"
  | "cross-site-check-on-bearer"
  | "drops-client-address"
  | "never-secure"
  | "upgrade-is-safe"
  | "upgrade-ignores-auth";

interface Entry {
  readonly info: RouteInfo;
  readonly handler: RouteHandler;
  readonly options: RouteOptions;
}

function match(
  pattern: string,
  path: string,
): Record<string, string> | undefined {
  const expected = pattern.split("/");
  const actual = path.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of expected.entries()) {
    const value = actual[index] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = value;
    else if (part !== value) return undefined;
  }
  return params;
}

function cookieToken(request: Request): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, value] = pair.trim().split("=");
    if (name === SESSION_COOKIE && value) return value;
  }
  return undefined;
}

function refuse(socket: unknown, status: number): void {
  if (
    typeof socket !== "object" ||
    socket === null ||
    !("write" in socket) ||
    typeof socket.write !== "function" ||
    !("destroy" in socket) ||
    typeof socket.destroy !== "function"
  ) {
    throw new Error("expected a socket");
  }
  socket.write(`HTTP/1.1 ${status} Refused\r\n\r\n`);
  socket.destroy();
}

function json(status: number): Response {
  return Response.json({ code: "test", message: "test" }, { status });
}

/** An in-memory implementation that passes the suite unless `bug` is set. */
function createInMemoryHttp(bug?: Bug): HttpConformanceSubject {
  const routes = new Map<string, Entry>();
  const upgrades = new Map<
    string,
    { handler: UpgradeHandler; options: RouteOptions }
  >();
  const sessions = new Map<string, string>();
  let counter = 0;

  function admit(
    request: Request,
    isRoutePublic: boolean,
    options: RouteOptions,
    isUnsafe: boolean,
  ): Actor | number {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const bearer = /^bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    const fromCookie =
      authorization === null && bug !== "bearer-only"
        ? cookieToken(request)
        : undefined;
    const userId = sessions.get(bearer ?? fromCookie ?? "");
    const isPublic = isRoutePublic || bug === "everything-public";
    if (userId === undefined && !isPublic) return 401;
    const actor: Actor =
      userId === undefined || (isRoutePublic && bug === "public-is-anonymous")
        ? { kind: "anonymous" }
        : { kind: "user", userId };
    const origin = request.headers.get("origin");
    const isCrossSite =
      origin === null
        ? bug !== "origin-only-cross-site-check" &&
          request.headers.get("sec-fetch-site") === "cross-site"
        : origin !== url.origin;
    const isCookieSession =
      bug === "cross-site-check-on-bearer" || fromCookie !== undefined;
    if (
      bug !== "no-cross-site-check" &&
      actor.kind === "user" &&
      isCookieSession &&
      isUnsafe &&
      isCrossSite
    ) {
      return 403;
    }
    if (options.authorize) return 403;
    return actor;
  }

  const http: HttpService = {
    route(method, path, handler, options = {}) {
      const key = `${method} ${path}`;
      if (options.public && options.authorize) throw new Error("both");
      if (routes.has(key)) throw new Error(`${key} is registered`);
      routes.set(key, {
        info: { method, path, isPublic: options.public === true },
        handler,
        options,
      });
      return () => routes.delete(key);
    },
    upgrade(path, handler, options = {}) {
      if (options.public && options.authorize) throw new Error("both");
      if (upgrades.has(path)) throw new Error(`${path} is registered`);
      upgrades.set(path, { handler, options });
      return () => upgrades.delete(path);
    },
    async handleUpgrade(request, raw, info = {}) {
      const entry = upgrades.get(new URL(request.url).pathname);
      if (!entry) return refuse(raw.socket, 404);
      const admission =
        bug === "upgrade-ignores-auth"
          ? ({ kind: "user", userId: "nobody" } satisfies Actor)
          : admit(
              request,
              entry.options.public === true,
              entry.options,
              bug !== "upgrade-is-safe",
            );
      if (typeof admission === "number") return refuse(raw.socket, admission);
      await entry.handler({
        request,
        params: {},
        actor: admission,
        clientAddress: info.clientAddress,
        incoming: raw.incoming,
        socket: raw.socket,
        head: raw.head,
      });
    },
    routes() {
      return [...routes.values()].map((entry) => entry.info);
    },
    async fetch(request, info = {}) {
      const url = new URL(request.url);
      for (const entry of routes.values()) {
        if (entry.info.method !== request.method) continue;
        const params = match(entry.info.path, url.pathname);
        if (!params) continue;
        const admission = admit(
          request,
          entry.info.isPublic,
          entry.options,
          !["GET", "HEAD", "OPTIONS"].includes(request.method),
        );
        if (typeof admission === "number") return json(admission);
        return entry.handler({
          request,
          params,
          actor: admission,
          clientAddress:
            bug === "drops-client-address" ? undefined : info.clientAddress,
        });
      }
      return json(404);
    },
    sessionCookie(request, token) {
      const parts = [
        `${SESSION_COOKIE}=${token ?? ""}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
      ];
      if (token === undefined) parts.push("Max-Age=0");
      if (bug !== "never-secure" && request.url.startsWith("https:")) {
        parts.push("Secure");
      }
      return parts.join("; ");
    },
  };
  return {
    http,
    async signIn() {
      counter += 1;
      const token = `token${counter}`;
      const userId = `user-${counter}`;
      sessions.set(token, userId);
      return { token, userId };
    },
  };
}

describe("the in-memory reference implementation", () => {
  runConformanceSuite(httpConformanceSuite, () => createInMemoryHttp());
});

describe("deliberately broken http implementations", () => {
  const cases: [Bug, string[]][] = [
    [
      "everything-public",
      [
        "a non-public route without credentials answers 401",
        "a non-public route with an unknown token or cookie answers 401",
      ],
    ],
    [
      "bearer-only",
      ["a bearer token and the session cookie both authenticate the user"],
    ],
    [
      "public-is-anonymous",
      [
        "a public route sees the signed-in user, and an anonymous actor without one",
      ],
    ],
    [
      "no-cross-site-check",
      ["a cookie-authenticated unsafe request from another site answers 403"],
    ],
    [
      "origin-only-cross-site-check",
      ["a cookie-authenticated unsafe request from another site answers 403"],
    ],
    [
      "cross-site-check-on-bearer",
      [
        "a cross-site safe request with the cookie, and a cross-site request with a bearer token, are served",
      ],
    ],
    [
      "drops-client-address",
      ["the handler receives the route params and the client address"],
    ],
    [
      "never-secure",
      ["sessionCookie starts and ends the session cookie with safe attributes"],
    ],
    [
      "upgrade-is-safe",
      [
        "a cookie-authenticated upgrade from another site answers 403, and one with a bearer token is served",
      ],
    ],
    [
      "upgrade-ignores-auth",
      [
        "an upgrade reaches its handler only when allowed, and is answered with 401 or 404 on the socket otherwise",
      ],
    ],
  ];
  for (const [bug, names] of cases) {
    it(`rejects "${bug}"`, async () => {
      for (const name of names) {
        const invariant = httpConformanceSuite.invariants.find(
          (candidate) => candidate.name === name,
        );
        if (!invariant) throw new Error(`expected invariant "${name}"`);
        await expect(
          checkInvariant(invariant, () => createInMemoryHttp(bug)),
        ).rejects.toThrow();
      }
    });
  }
});
