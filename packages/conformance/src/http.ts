import { SESSION_COOKIE, type HttpService } from "@docleus/sdk";
import { expect } from "vitest";
import { defineConformanceSuite } from "./suite.ts";

/** What the `http` suite runs against: the service and a way to sign a user in. */
export interface HttpConformanceSubject {
  readonly http: HttpService;
  /** Creates a user with a session whose token the service accepts. */
  signIn(): Promise<{ readonly token: string; readonly userId: string }>;
}

const ORIGIN = "http://localhost";

function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, { method, headers });
}

const get = (http: HttpService, path: string) =>
  http.fetch(request("GET", path));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

interface RecordingSocket {
  written: string;
  isDestroyed: boolean;
  write(data: string): boolean;
  destroy(): void;
}

function recordingSocket(): RecordingSocket {
  return {
    written: "",
    isDestroyed: false,
    write(data) {
      this.written += data;
      return true;
    },
    destroy() {
      this.isDestroyed = true;
    },
  };
}

/** Sends an upgrade request and returns the status written on the socket, or `undefined` when the handler took it. */
async function upgradeStatus(
  http: HttpService,
  path: string,
  headers: Record<string, string> = {},
): Promise<number | undefined> {
  const socket = recordingSocket();
  await http.handleUpgrade(
    request("GET", path, {
      connection: "Upgrade",
      upgrade: "websocket",
      ...headers,
    }),
    { incoming: undefined, socket, head: undefined },
  );
  if (socket.written === "" && !socket.isDestroyed) return undefined;
  expect(socket.isDestroyed).toBe(true);
  const status = /^HTTP\/1\.1 (\d{3}) /.exec(socket.written)?.[1];
  return status === undefined ? Number.NaN : Number(status);
}

function cookieAttributes(value: string): string[] {
  return value.split(";").map((part) => part.trim().toLowerCase());
}

function echoActor(http: HttpService, method: "GET" | "POST", path: string) {
  http.route(method, path, ({ actor }) =>
    Response.json(actor.kind === "user" ? actor.userId : null),
  );
}

export const httpConformanceSuite =
  defineConformanceSuite<HttpConformanceSubject>("http", [
    {
      name: "an unregistered path answers 404",
      async check({ http }) {
        expect((await get(http, "/missing")).status).toBe(404);
      },
    },
    {
      name: "a public route is reachable without credentials",
      async check({ http }) {
        http.route("GET", "/public", () => new Response("ok"), {
          public: true,
        });
        expect(await (await get(http, "/public")).text()).toBe("ok");
      },
    },
    {
      name: "a non-public route without credentials answers 401",
      async check({ http }) {
        http.route("GET", "/private", () => new Response("ok"));
        http.route("POST", "/private", () => new Response("ok"));
        expect((await get(http, "/private")).status).toBe(401);
        expect((await http.fetch(request("POST", "/private"))).status).toBe(
          401,
        );
      },
    },
    {
      name: "a non-public route with an unknown token or cookie answers 401",
      async check({ http }) {
        http.route("GET", "/private", () => new Response("ok"));
        for (const headers of [
          bearer("no-such-token"),
          cookie("no-such-token"),
          { authorization: "Basic dXNlcjpwYXNz" },
        ]) {
          expect(
            (await http.fetch(request("GET", "/private", headers))).status,
          ).toBe(401);
        }
      },
    },
    {
      name: "a bearer token and the session cookie both authenticate the user",
      async check({ http, signIn }) {
        const { token, userId } = await signIn();
        echoActor(http, "GET", "/me");
        for (const headers of [
          bearer(token),
          { authorization: `bearer ${token}` },
          cookie(token),
          { cookie: `other=1; ${SESSION_COOKIE}=${token}; more=2` },
        ]) {
          const response = await http.fetch(request("GET", "/me", headers));
          expect(response.status).toBe(200);
          expect(await response.json()).toBe(userId);
        }
      },
    },
    {
      name: "a public route sees the signed-in user, and an anonymous actor without one",
      async check({ http, signIn }) {
        const { token, userId } = await signIn();
        http.route(
          "GET",
          "/whoami",
          ({ actor }) =>
            Response.json(actor.kind === "user" ? actor.userId : null),
          { public: true },
        );
        const fetchAs = async (headers: Record<string, string>) =>
          (await http.fetch(request("GET", "/whoami", headers))).json();
        expect(await fetchAs(bearer(token))).toBe(userId);
        expect(await fetchAs(cookie(token))).toBe(userId);
        expect(await fetchAs({})).toBeNull();
        expect(await fetchAs(cookie("no-such-token"))).toBeNull();
      },
    },
    {
      name: "a cookie-authenticated unsafe request from another site answers 403",
      async check({ http, signIn }) {
        const { token } = await signIn();
        let calls = 0;
        http.route("POST", "/act", () => {
          calls += 1;
          return new Response("done");
        });
        const fromElsewhere: Record<string, string>[] = [
          { origin: "https://evil.example" },
          { origin: "null" },
          { origin: "https://localhost" },
          { "sec-fetch-site": "cross-site" },
        ];
        for (const headers of fromElsewhere) {
          const response = await http.fetch(
            request("POST", "/act", { ...cookie(token), ...headers }),
          );
          expect(response.status).toBe(403);
        }
        expect(calls).toBe(0);
      },
    },
    {
      name: "a cookie-authenticated unsafe request from the same site is served",
      async check({ http, signIn }) {
        const { token, userId } = await signIn();
        echoActor(http, "POST", "/act");
        const fromHere: Record<string, string>[] = [
          { origin: ORIGIN },
          { "sec-fetch-site": "same-origin" },
          {},
        ];
        for (const headers of fromHere) {
          const response = await http.fetch(
            request("POST", "/act", { ...cookie(token), ...headers }),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toBe(userId);
        }
      },
    },
    {
      name: "a cross-site safe request with the cookie, and a cross-site request with a bearer token, are served",
      async check({ http, signIn }) {
        const { token, userId } = await signIn();
        echoActor(http, "GET", "/read");
        echoActor(http, "POST", "/act");
        const fromElsewhere = { origin: "https://evil.example" };
        const read = await http.fetch(
          request("GET", "/read", { ...cookie(token), ...fromElsewhere }),
        );
        expect(await read.json()).toBe(userId);
        const act = await http.fetch(
          request("POST", "/act", { ...bearer(token), ...fromElsewhere }),
        );
        expect(act.status).toBe(200);
        expect(await act.json()).toBe(userId);
      },
    },
    {
      name: "the handler receives the route params and the client address",
      async check({ http }) {
        http.route(
          "GET",
          "/items/:id",
          ({ params, clientAddress }) =>
            Response.json({
              id: params.id,
              clientAddress: clientAddress ?? null,
            }),
          { public: true },
        );
        const withAddress = await http.fetch(request("GET", "/items/42"), {
          clientAddress: "192.0.2.7",
        });
        expect(await withAddress.json()).toEqual({
          id: "42",
          clientAddress: "192.0.2.7",
        });
        const without = await get(http, "/items/43");
        expect(await without.json()).toEqual({ id: "43", clientAddress: null });
      },
    },
    {
      name: "routes lists the registered routes in registration order",
      check({ http }) {
        expect(http.routes()).toEqual([]);
        http.route("POST", "/b", () => new Response("b"));
        const dispose = http.route("GET", "/a", () => new Response("a"), {
          public: true,
        });
        http.route("GET", "/c/:id", () => new Response("c"), {
          authorize: { action: "read", resource: { kind: "instance" } },
        });
        expect(http.routes()).toEqual([
          { method: "POST", path: "/b", isPublic: false },
          { method: "GET", path: "/a", isPublic: true },
          { method: "GET", path: "/c/:id", isPublic: false },
        ]);
        dispose();
        expect(http.routes().map((route) => route.path)).toEqual([
          "/b",
          "/c/:id",
        ]);
      },
    },
    {
      name: "sessionCookie starts and ends the session cookie with safe attributes",
      check({ http }) {
        const plain = cookieAttributes(
          http.sessionCookie(new Request("http://example.com/"), "abc_-123"),
        );
        expect(plain[0]).toBe(`${SESSION_COOKIE}=abc_-123`);
        expect(plain).toEqual(
          expect.arrayContaining(["httponly", "samesite=lax", "path=/"]),
        );
        expect(plain).not.toContain("secure");
        const secure = cookieAttributes(
          http.sessionCookie(new Request("https://example.com/"), "abc"),
        );
        expect(secure).toContain("secure");
        const cleared = cookieAttributes(
          http.sessionCookie(new Request("https://example.com/"), undefined),
        );
        expect(cleared[0]).toBe(`${SESSION_COOKIE}=`);
        expect(cleared).toEqual(
          expect.arrayContaining(["httponly", "path=/", "max-age=0"]),
        );
      },
    },
    {
      name: "a route that is both public and authorized is rejected at registration",
      check({ http }) {
        expect(() =>
          http.route("GET", "/both", () => new Response("ok"), {
            public: true,
            authorize: { action: "read", resource: { kind: "instance" } },
          }),
        ).toThrow();
      },
    },
    {
      name: "an authorized route answers 403 to a signed-in user the check denies",
      async check({ http, signIn }) {
        const { token } = await signIn();
        http.route("GET", "/admin", () => new Response("ok"), {
          authorize: { action: "manage", resource: { kind: "instance" } },
        });
        const response = await http.fetch(
          request("GET", "/admin", bearer(token)),
        );
        expect(response.status).toBe(403);
      },
    },
    {
      name: "registering the same method and path twice throws",
      check({ http }) {
        http.route("GET", "/dup", () => new Response("ok"), { public: true });
        expect(() =>
          http.route("GET", "/dup", () => new Response("ok"), { public: true }),
        ).toThrow();
      },
    },
    {
      name: "unregistering a route makes it 404 again",
      async check({ http }) {
        const dispose = http.route("GET", "/temp", () => new Response("ok"), {
          public: true,
        });
        dispose();
        expect((await get(http, "/temp")).status).toBe(404);
      },
    },
    {
      name: "unregistering one route leaves the others reachable",
      async check({ http }) {
        const dispose = http.route("GET", "/one", () => new Response("1"), {
          public: true,
        });
        http.route("GET", "/two", () => new Response("2"), { public: true });
        dispose();
        expect(await (await get(http, "/two")).text()).toBe("2");
      },
    },
    {
      name: "an upgrade reaches its handler only when allowed, and is answered with 401 or 404 on the socket otherwise",
      async check({ http, signIn }) {
        const { token, userId } = await signIn();
        const seen: (string | null)[] = [];
        http.upgrade("/live", ({ actor }) => {
          seen.push(actor.kind === "user" ? actor.userId : null);
        });
        http.upgrade(
          "/open",
          ({ actor }) => {
            seen.push(actor.kind === "user" ? actor.userId : null);
          },
          { public: true },
        );
        expect(await upgradeStatus(http, "/nothing")).toBe(404);
        expect(await upgradeStatus(http, "/live")).toBe(401);
        expect(await upgradeStatus(http, "/live", cookie("no-such"))).toBe(401);
        expect(
          await upgradeStatus(http, "/live", bearer(token)),
        ).toBeUndefined();
        expect(await upgradeStatus(http, "/open")).toBeUndefined();
        expect(seen).toEqual([userId, null]);
      },
    },
    {
      name: "a cookie-authenticated upgrade from another site answers 403, and one with a bearer token is served",
      async check({ http, signIn }) {
        const { token } = await signIn();
        let calls = 0;
        http.upgrade("/live", () => {
          calls += 1;
        });
        for (const headers of [
          { origin: "https://evil.example" },
          { "sec-fetch-site": "cross-site" },
        ] as Record<string, string>[]) {
          expect(
            await upgradeStatus(http, "/live", {
              ...cookie(token),
              ...headers,
            }),
          ).toBe(403);
        }
        expect(calls).toBe(0);
        expect(
          await upgradeStatus(http, "/live", {
            ...cookie(token),
            origin: ORIGIN,
          }),
        ).toBeUndefined();
        expect(
          await upgradeStatus(http, "/live", {
            ...bearer(token),
            origin: "https://evil.example",
          }),
        ).toBeUndefined();
        expect(calls).toBe(2);
      },
    },
    {
      name: "registering the same upgrade path twice throws, and unregistering frees it",
      async check({ http }) {
        const dispose = http.upgrade("/live", () => {}, { public: true });
        expect(() => http.upgrade("/live", () => {})).toThrow();
        dispose();
        expect(await upgradeStatus(http, "/live")).toBe(404);
      },
    },
  ]);
