import type { Actor, Scope } from "./scope.ts";
import type { Action } from "./authz.ts";

/** The HTTP methods a route can be registered for. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * What a route handler gets: the request, its path parameters and the authenticated actor.
 */
export interface HttpRequestContext {
  readonly request: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly actor: Actor;
  /** The client's IP address, when the server knows it. */
  readonly clientAddress: string | undefined;
}

/** Authentication and authorization of a route. */
export interface RouteOptions {
  /**
   * Skips the authentication requirement: the handler sees the signed-in
   * user when there is one, else an anonymous actor. Cannot be combined
   * with `authorize`.
   */
  public?: boolean;
  /** Authorization applied after authentication; a denied check answers 403. */
  authorize?: { action: Action; resource: Scope };
}

/** Answers a request to a registered route. */
export type RouteHandler = (
  context: HttpRequestContext,
) => Response | Promise<Response>;

/** A registered route, as `http.routes` lists it. */
export interface RouteInfo {
  readonly method: HttpMethod;
  readonly path: string;
  readonly isPublic: boolean;
}

/** What the server knows about a request beyond the `Request` itself. */
export interface FetchInfo {
  readonly clientAddress?: string;
}

/**
 * What an upgrade handler gets: the authenticated request, and the raw Node
 * upgrade, which the handler owns from then on (for example to hand it to a
 * WebSocket server).
 */
export interface UpgradeContext extends HttpRequestContext {
  /** Node's `http.IncomingMessage`. */
  readonly incoming: unknown;
  /** Node's `stream.Duplex` socket. */
  readonly socket: unknown;
  /** Node's `Buffer` with the first packet of the upgraded stream. */
  readonly head: unknown;
}

/** Takes over an upgraded connection, such as a WebSocket. */
export type UpgradeHandler = (context: UpgradeContext) => void | Promise<void>;

/** The raw Node upgrade a server passes to {@link HttpService.handleUpgrade}. */
export interface RawUpgrade {
  readonly incoming: unknown;
  readonly socket: unknown;
  readonly head: unknown;
}

/** Name of the cookie that carries the browser session. */
export const SESSION_COOKIE = "docleus_session";

/**
 * Route registry for the instance API.
 *
 * A request is authenticated by a `Bearer` token in `authorization`, else by
 * the session cookie. A request authenticated by the cookie with an unsafe
 * method (anything but GET, HEAD and OPTIONS) is rejected with 403 when its
 * `Origin` (or, without one, `Sec-Fetch-Site`) shows that it comes from
 * another site.
 *
 * @stability experimental
 */
export interface HttpService {
  /** Throws when the method and path are already registered. The returned function removes the route. */
  route(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    options?: RouteOptions,
  ): () => void;
  /**
   * Registers a handler for HTTP upgrade requests (such as WebSocket) to
   * `path`, authenticated and authorized like a route, and subject to the
   * same cross-site check as unsafe methods. Throws when `path` is taken.
   * The returned function removes it.
   */
  upgrade(
    path: string,
    handler: UpgradeHandler,
    options?: RouteOptions,
  ): () => void;
  /**
   * Called by the server for every upgrade request. Answers with 401, 403
   * or 404 on the socket and closes it when there is no handler or the
   * request is not allowed; otherwise calls the handler.
   */
  handleUpgrade(
    request: Request,
    raw: RawUpgrade,
    info?: FetchInfo,
  ): Promise<void>;
  /** The registered routes, in registration order. */
  routes(): RouteInfo[];
  /** Without credentials, routes that are not public answer 401. */
  fetch(request: Request, info?: FetchInfo): Promise<Response>;
  /**
   * A `Set-Cookie` value that starts the browser session for `token`, or
   * ends it when `token` is undefined. `HttpOnly`, `SameSite=Lax`, `Path=/`;
   * `Secure` when the request came over HTTPS.
   */
  sessionCookie(request: Request, token: string | undefined): string;
}
