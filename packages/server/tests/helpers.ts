import { fileURLToPath } from "node:url";
import { testStorageLocation } from "@docleus/testing";
import {
  createInstance,
  type Instance,
  type InstanceOptions,
  type MailMessage,
  type Mailer,
} from "../src/index.ts";

export const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

export const ORIGIN = "http://localhost";

export interface Credentials {
  readonly token?: string;
  /** A `Cookie` header value. */
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
  readonly clientAddress?: string;
}

export interface Client {
  call(method: string, path: string, body?: unknown): Promise<Response>;
  json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T>;
}

export function client(
  instance: Instance,
  credentials: Credentials = {},
): Client {
  const call = (method: string, path: string, body?: unknown) =>
    instance.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(credentials.token && {
            authorization: `Bearer ${credentials.token}`,
          }),
          ...(credentials.cookie && { cookie: credentials.cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
          ...credentials.headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
      credentials.clientAddress
        ? { clientAddress: credentials.clientAddress }
        : {},
    );
  return {
    call,
    async json(method, path, body) {
      const response = await call(method, path, body);
      if (!response.ok) {
        throw new Error(
          `${method} ${path}: ${response.status} ${await response.text()}`,
        );
      }
      return (await response.json()) as never;
    },
  };
}

/** The `name=value` part of a response's `Set-Cookie`, for the next request's `Cookie`. */
export function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("expected a Set-Cookie header");
  return header.split(";")[0] ?? "";
}

export interface FakeMailer extends Mailer {
  readonly sent: MailMessage[];
  isFailing: boolean;
}

export function fakeMailer(): FakeMailer {
  const sent: MailMessage[] = [];
  return {
    sent,
    isFailing: false,
    async send(message) {
      if (this.isFailing) throw new Error("smtp is down");
      sent.push(message);
    },
  };
}

export function bootWith(instances: Instance[]) {
  return async (options: InstanceOptions = {}) => {
    const instance = await createInstance({
      baseDir: fixtures,
      plugins: [{ id: "browser", plugin: "browser" }],
      appDir: `${fixtures}app`,
      database: options.dataDir ? undefined : await testStorageLocation(),
      ...options,
    });
    instances.push(instance);
    return instance;
  };
}

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly api: Client;
}

/** A user with a password and a session, optionally an instance admin. */
export async function account(
  instance: Instance,
  email: string,
  options: { isAdmin?: boolean; password?: string } = {},
): Promise<Account> {
  const user = await instance.ctx.identity.createUser({
    email,
    name: email.split("@")[0] ?? email,
    password: options.password ?? "correct horse",
  });
  if (options.isAdmin) {
    await instance.ctx.authz.grant(user.id, { kind: "instance" }, "admin");
  }
  const token = await instance.ctx.identity.createSession(user.id);
  return { id: user.id, email, token, api: client(instance, { token }) };
}
