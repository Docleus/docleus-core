import { DocleusError, type Context } from "@docleus/kernel";
import {
  ANONYMOUS,
  DEFAULT_SESSION_TTL_MS,
  SESSION_COOKIE,
  trackCaller,
  type Actor,
  type FetchInfo,
  type HttpMethod,
  type HttpService,
  type RouteHandler,
  type RouteInfo,
  type RouteOptions,
  type UpgradeHandler,
} from "@docleus/sdk";
import { Hono } from "hono";

export interface HttpServiceOptions {
  /**
   * Trusts the `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`
   * headers of a reverse proxy in front of the server: they decide whether a
   * request came over HTTPS, which origin it was sent to, and the client
   * address. Off by default, since any client can set them.
   */
  readonly trustProxy?: boolean;
}

interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler;
  readonly options: RouteOptions;
}

type Credential =
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "cookie"; readonly token: string }
  | { readonly kind: "none" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE_VALUE = /^[0-9A-Za-z_-]+$/;

function credential(request: Request): Credential {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^bearer\s+(\S+)$/i.exec(authorization);
    return match?.[1] === undefined
      ? { kind: "bearer", token: "" }
      : { kind: "bearer", token: match[1] };
  }
  const token = sessionCookieValue(request);
  return token === undefined ? { kind: "none" } : { kind: "cookie", token };
}

function sessionCookieValue(request: Request): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (value !== "") return value;
  }
  return undefined;
}

function firstHeaderValue(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.split(",")[0]?.trim();
  return value === "" ? undefined : value;
}

interface Refusal {
  readonly status: 401 | 403 | 404;
  readonly code: string;
  readonly message: string;
}

type Admission =
  | { readonly isAllowed: true; readonly actor: Actor }
  | { readonly isAllowed: false; readonly refusal: Refusal };

interface Upgrade {
  readonly path: string;
  readonly handler: UpgradeHandler;
  readonly options: RouteOptions;
}

interface UpgradeSocket {
  write(data: string): unknown;
  destroy(): unknown;
}

const STATUS_TEXT: Readonly<Record<Refusal["status"], string>> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
};

function errorResponse(refusal: Refusal) {
  return Response.json(
    { code: refusal.code, message: refusal.message },
    { status: refusal.status },
  );
}

function isUpgradeSocket(value: unknown): value is UpgradeSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    typeof value.write === "function" &&
    "destroy" in value &&
    typeof value.destroy === "function"
  );
}

function refuseUpgrade(socket: unknown, refusal: Refusal): void {
  if (!isUpgradeSocket(socket)) return;
  const body = JSON.stringify({ code: refusal.code, message: refusal.message });
  socket.write(
    `HTTP/1.1 ${refusal.status} ${STATUS_TEXT[refusal.status]}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${new TextEncoder().encode(body).byteLength}\r\n` +
      `\r\n${body}`,
  );
  socket.destroy();
}

function refused(
  status: Refusal["status"],
  code: string,
  message: string,
): Admission {
  return { isAllowed: false, refusal: { status, code, message } };
}

function assertValidOptions(key: string, routeOptions: RouteOptions): void {
  if (routeOptions.public && routeOptions.authorize) {
    throw new DocleusError(
      "http/invalid-options",
      `route "${key}" cannot be both public and authorized`,
    );
  }
}

/**
 * Default `http` implementation: a Hono route registry that rebuilds and
 * atomically replaces its router whenever a route is added or removed, and
 * applies authentication, the cross-site check for cookie sessions, and
 * authorization before dispatching. Its own 401 and 403 answers are JSON
 * `{ code, message }` with the codes `http/unauthorized`,
 * `http/cross-site-request` and `http/forbidden`.
 *
 * @stability experimental
 */
export function createHttpService(
  ctx: Context,
  options: HttpServiceOptions = {},
): HttpService {
  const isProxyTrusted = options.trustProxy === true;
  const routes = new Map<string, Route>();
  const upgrades = new Map<string, Upgrade>();
  let router = new Hono<{ Bindings: { clientAddress: string | undefined } }>();

  function isHttps(request: Request): boolean {
    const forwarded = isProxyTrusted
      ? firstHeaderValue(request, "x-forwarded-proto")
      : undefined;
    if (forwarded !== undefined) return forwarded.toLowerCase() === "https";
    return new URL(request.url).protocol === "https:";
  }

  function requestOrigin(request: Request): string {
    const url = new URL(request.url);
    const host =
      (isProxyTrusted
        ? firstHeaderValue(request, "x-forwarded-host")
        : undefined) ?? url.host;
    return `${isHttps(request) ? "https" : "http"}://${host}`;
  }

  function isCrossSite(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (origin !== null) return origin !== requestOrigin(request);
    return request.headers.get("sec-fetch-site") === "cross-site";
  }

  async function admit(
    request: Request,
    routeOptions: RouteOptions,
    isUnsafe: boolean,
  ): Promise<Admission> {
    const presented = credential(request);
    let actor: Actor = ANONYMOUS;
    if (presented.kind !== "none") {
      const user =
        presented.token === ""
          ? undefined
          : await ctx.identity.authenticate(presented.token);
      if (user) actor = { kind: "user", userId: user.id };
      else if (presented.kind === "bearer" && !routeOptions.public) {
        return refused(
          401,
          "http/unauthorized",
          "the bearer token is invalid or expired",
        );
      }
    }
    if (actor.kind === "anonymous" && !routeOptions.public) {
      return refused(401, "http/unauthorized", "sign in to use this route");
    }
    if (
      actor.kind === "user" &&
      presented.kind === "cookie" &&
      isUnsafe &&
      isCrossSite(request)
    ) {
      return refused(
        403,
        "http/cross-site-request",
        "a cookie-authenticated request from another site was rejected",
      );
    }
    if (routeOptions.authorize) {
      const isAllowed = await ctx.authz.can(
        actor,
        routeOptions.authorize.action,
        routeOptions.authorize.resource,
      );
      if (!isAllowed) {
        return refused(403, "http/forbidden", "you are not allowed to do this");
      }
    }
    return { isAllowed: true, actor };
  }

  function clientAddressOf(
    request: Request,
    info: FetchInfo,
  ): string | undefined {
    const forwarded = isProxyTrusted
      ? firstHeaderValue(request, "x-forwarded-for")
      : undefined;
    return forwarded ?? info.clientAddress;
  }

  function rebuild(): void {
    const next = new Hono<{
      Bindings: { clientAddress: string | undefined };
    }>();
    for (const entry of routes.values()) {
      next.on(entry.method, entry.path, async (c) => {
        const request = c.req.raw;
        const admission = await admit(
          request,
          entry.options,
          !SAFE_METHODS.has(request.method),
        );
        if (!admission.isAllowed) return errorResponse(admission.refusal);
        return entry.handler({
          request,
          params: c.req.param(),
          actor: admission.actor,
          clientAddress: c.env.clientAddress,
        });
      });
    }
    router = next;
  }

  return trackCaller<HttpService>(ctx, {
    upgrade(path, handler, routeOptions = {}) {
      assertValidOptions(`upgrade ${path}`, routeOptions);
      return this.ctx.effect(
        () => {
          if (upgrades.has(path)) {
            throw new DocleusError(
              "http/already-registered",
              `upgrade "${path}" is already registered`,
            );
          }
          upgrades.set(path, { path, handler, options: routeOptions });
          return () => {
            upgrades.delete(path);
          };
        },
        `ctx.http.upgrade(${JSON.stringify(path)})`,
      );
    },
    async handleUpgrade(request, raw, info = {}) {
      const entry = upgrades.get(new URL(request.url).pathname);
      if (entry === undefined) {
        refuseUpgrade(raw.socket, {
          status: 404,
          code: "http/not-found",
          message: "nothing accepts upgrades on this path",
        });
        return;
      }
      // Upgrades count as unsafe: a WebSocket is not bound by CORS, so the
      // cross-site check is all that keeps another site from using the cookie.
      const admission = await admit(request, entry.options, true);
      if (!admission.isAllowed) {
        refuseUpgrade(raw.socket, admission.refusal);
        return;
      }
      await entry.handler({
        request,
        params: {},
        actor: admission.actor,
        clientAddress: clientAddressOf(request, info),
        incoming: raw.incoming,
        socket: raw.socket,
        head: raw.head,
      });
    },
    route(method, path, handler, routeOptions = {}) {
      const key = `${method} ${path}`;
      assertValidOptions(key, routeOptions);
      return this.ctx.effect(
        () => {
          if (routes.has(key)) {
            throw new DocleusError(
              "http/already-registered",
              `route "${key}" is already registered`,
            );
          }
          routes.set(key, { method, path, handler, options: routeOptions });
          rebuild();
          return () => {
            routes.delete(key);
            rebuild();
          };
        },
        `ctx.http.route(${JSON.stringify(key)})`,
      );
    },
    routes() {
      return [...routes.values()].map((entry): RouteInfo => ({
        method: entry.method,
        path: entry.path,
        isPublic: entry.options.public === true,
      }));
    },
    fetch: async (request, info = {}) =>
      router.fetch(request, { clientAddress: clientAddressOf(request, info) }),
    sessionCookie(request, token) {
      if (token !== undefined && !COOKIE_VALUE.test(token)) {
        throw new DocleusError(
          "http/invalid-cookie-value",
          "a session token must only contain base64url characters",
        );
      }
      const attributes = [
        `${SESSION_COOKIE}=${token ?? ""}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        `Max-Age=${token === undefined ? 0 : Math.floor(DEFAULT_SESSION_TTL_MS / 1000)}`,
      ];
      if (isHttps(request)) attributes.push("Secure");
      return attributes.join("; ");
    },
  });
}

export function provideHttp(
  ctx: Context,
  options?: HttpServiceOptions,
): () => void {
  return ctx.provide("http", createHttpService(ctx, options));
}
