import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testStorageLocation } from "@docleus/testing";
import { createInstance, type Instance } from "../src/index.ts";
import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN, account, bootWith, client, cookieOf } from "./helpers.ts";

const instances: Instance[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

const MINUTE = 60 * 1000;

const attemptFromOneAddress = (instance: Instance, password: string) =>
  client(instance, { clientAddress: "10.0.0.1" }).call(
    "POST",
    "/api/auth/login",
    { email: "ada@example.com", password },
  );

describe("first-run setup", () => {
  it("creates the first admin with the setup token and signs them in", async () => {
    const instance = await boot();
    const token = instance.setupToken;
    if (!token) throw new Error("expected a setup token");
    const anonymous = client(instance);
    expect(await anonymous.json("GET", "/api/setup")).toEqual({
      required: true,
    });

    const wrong = await anonymous.call("POST", "/api/setup", {
      token: "nope",
      email: "ada@example.com",
      name: "Ada",
      password: "correct horse",
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: "setup/invalid-token" });

    const response = await anonymous.call("POST", "/api/setup", {
      token,
      email: "Ada@Example.com",
      name: "Ada",
      password: "correct horse",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ user: { email: "ada@example.com" } });
    expect(body).not.toHaveProperty("token");

    const me = client(instance, { cookie: cookieOf(response) });
    expect(await me.json("GET", "/api/me")).toMatchObject({
      user: { email: "ada@example.com", hasPassword: true },
      isAdmin: true,
    });
    expect(await anonymous.json("GET", "/api/setup")).toEqual({
      required: false,
    });
    expect(await anonymous.json("GET", "/api/auth/methods")).toMatchObject({
      setupRequired: false,
    });

    const again = await anonymous.call("POST", "/api/setup", {
      token,
      email: "eve@example.com",
      name: "Eve",
      password: "correct horse",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "setup/already-done" });
  });

  it("creates one admin when two setups race", async () => {
    const instance = await boot();
    const token = instance.setupToken ?? "";
    const attempt = (email: string) =>
      client(instance).call("POST", "/api/setup", {
        token,
        email,
        name: "Admin",
        password: "correct horse",
      });
    const statuses = (
      await Promise.all([attempt("a@example.com"), attempt("b@example.com")])
    ).map((response) => response.status);
    expect(statuses.toSorted()).toEqual([201, 409]);
    expect(await instance.ctx.identity.countUsers()).toBe(1);
  });

  it("offers no setup once the instance has users, or in development", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "docleus-setup-"));
    try {
      const first = await createInstance({ dataDir });
      expect(first.setupToken).toBeDefined();
      await first.ctx.identity.createUser({
        email: "ada@example.com",
        name: "Ada",
      });
      await first.dispose();
      const second = await createInstance({ dataDir });
      expect(second.setupToken).toBeUndefined();
      await second.dispose();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }

    const dev = await boot({ isDev: true });
    expect(dev.setupToken).toBeUndefined();
    expect(await client(dev).json("GET", "/api/setup")).toEqual({
      required: false,
    });
  });

  it("rejects a weak password", async () => {
    const instance = await boot();
    const response = await client(instance).call("POST", "/api/setup", {
      token: instance.setupToken,
      email: "ada@example.com",
      name: "Ada",
      password: "short",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "identity/invalid-password",
    });
    expect(await instance.ctx.identity.countUsers()).toBe(0);
  });
});

describe("password sign-in", () => {
  it("signs in with a cookie session and signs out", async () => {
    const instance = await boot();
    await account(instance, "ada@example.com");
    const anonymous = client(instance);

    const wrong = await anonymous.call("POST", "/api/auth/login", {
      email: "ada@example.com",
      password: "wrong password",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      code: "auth/invalid-credentials",
    });
    const unknown = await anonymous.call("POST", "/api/auth/login", {
      email: "nobody@example.com",
      password: "correct horse",
    });
    expect(unknown.status).toBe(401);

    const response = await anonymous.call("POST", "/api/auth/login", {
      email: "ADA@example.com",
      password: "correct horse",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ user: { email: "ada@example.com" } });
    expect(body).not.toHaveProperty("token");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^docleus_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const cookie = cookieOf(response);
    const session = client(instance, { cookie });
    expect(await session.json("GET", "/api/me")).toMatchObject({
      user: { email: "ada@example.com" },
    });

    const logout = await session.call("POST", "/api/auth/logout");
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(/^docleus_session=;/);
    expect((await session.call("GET", "/api/orgs")).status).toBe(401);
  });

  it("signs out a bearer session", async () => {
    const instance = await boot();
    const ada = await account(instance, "ada@example.com");
    await ada.api.json("POST", "/api/auth/logout");
    expect((await ada.api.call("GET", "/api/orgs")).status).toBe(401);
  });

  it("limits failed sign-ins per account and address, and a success resets the account", async () => {
    let now = 1_000_000;
    const instance = await boot({ now: () => now });
    await account(instance, "ada@example.com");
    const from = (clientAddress: string) => client(instance, { clientAddress });
    const attempt = (
      address: string,
      password: string,
      email = "ada@example.com",
    ) => from(address).call("POST", "/api/auth/login", { email, password });

    for (let i = 0; i < 4; i++) {
      expect((await attempt("10.0.0.1", "wrong password")).status).toBe(401);
    }
    expect((await attempt("10.0.0.1", "correct horse")).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await attempt("10.0.0.1", "wrong password")).status).toBe(401);
    }
    const limited = await attempt("10.0.0.1", "correct horse");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "auth/rate-limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await attempt("10.0.0.2", "correct horse")).status).toBe(200);

    now += 15 * MINUTE + 1;
    expect((await attempt("10.0.0.1", "correct horse")).status).toBe(200);
  });

  it("limits failed sign-ins from one address across accounts", async () => {
    let now = 1_000_000;
    const instance = await boot({ now: () => now });
    await account(instance, "ada@example.com");
    for (let i = 0; i < 50; i++) {
      const response = await client(instance, {
        clientAddress: "10.0.0.9",
      }).call("POST", "/api/auth/login", {
        email: `user${i}@example.com`,
        password: "wrong password",
      });
      expect(response.status).toBe(401);
    }
    const limited = await client(instance, { clientAddress: "10.0.0.9" }).call(
      "POST",
      "/api/auth/login",
      { email: "ada@example.com", password: "correct horse" },
    );
    expect(limited.status).toBe(429);
    now += 15 * MINUTE + 1;
    const later = await client(instance, { clientAddress: "10.0.0.9" }).call(
      "POST",
      "/api/auth/login",
      { email: "ada@example.com", password: "correct horse" },
    );
    expect(later.status).toBe(200);
  });

  it("shares failed sign-ins between web processes on one database", async () => {
    let now = 1_000_000;
    const dir = await mkdtemp(join(tmpdir(), "docleus-auth-"));
    try {
      const database = (await testStorageLocation()) ?? join(dir, "docleus.db");
      const first = await boot({ database, role: "web", now: () => now });
      await account(first, "ada@example.com");
      const second = await boot({ database, role: "web", now: () => now });
      for (let i = 0; i < 3; i++) {
        expect(
          (await attemptFromOneAddress(first, "wrong password")).status,
        ).toBe(401);
      }
      for (let i = 0; i < 2; i++) {
        expect(
          (await attemptFromOneAddress(second, "wrong password")).status,
        ).toBe(401);
      }
      expect((await attemptFromOneAddress(first, "correct horse")).status).toBe(
        429,
      );
      expect(
        (await attemptFromOneAddress(second, "correct horse")).status,
      ).toBe(429);

      now += 15 * MINUTE + 1;
      expect(
        (await attemptFromOneAddress(second, "correct horse")).status,
      ).toBe(200);
    } finally {
      await Promise.all(instances.splice(0).map((each) => each.dispose()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes the password, ending every other session", async () => {
    const instance = await boot();
    const ada = await account(instance, "ada@example.com");
    const other = await instance.ctx.identity.createSession(ada.id);

    const missing = await ada.api.call("PUT", "/api/me/password", {
      password: "new password",
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({
      code: "account/wrong-password",
    });
    const wrong = await ada.api.call("PUT", "/api/me/password", {
      current: "nope nope",
      password: "new password",
    });
    expect(wrong.status).toBe(403);

    const response = await ada.api.call("PUT", "/api/me/password", {
      current: "correct horse",
      password: "new password",
    });
    expect(response.status).toBe(200);
    expect((await ada.api.call("GET", "/api/orgs")).status).toBe(401);
    expect(
      (await client(instance, { token: other }).call("GET", "/api/orgs"))
        .status,
    ).toBe(401);
    const fresh = client(instance, { cookie: cookieOf(response) });
    expect((await fresh.call("GET", "/api/orgs")).status).toBe(200);
    expect(
      await instance.ctx.identity.verifyPassword(
        "ada@example.com",
        "new password",
      ),
    ).toMatchObject({ id: ada.id });
  });

  it("sets a first password without the current one", async () => {
    const instance = await boot();
    const user = await instance.ctx.identity.createUser({
      email: "oidc@example.com",
      name: "Oidc",
    });
    const token = await instance.ctx.identity.createSession(user.id);
    const response = await client(instance, { token }).call(
      "PUT",
      "/api/me/password",
      { password: "first password" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { hasPassword: true },
    });
  });
});

describe("cookie sessions and cross-site requests", () => {
  it("rejects a cookie-authenticated write from another site", async () => {
    const instance = await boot();
    await account(instance, "ada@example.com", { isAdmin: true });
    const login = await client(instance).call("POST", "/api/auth/login", {
      email: "ada@example.com",
      password: "correct horse",
    });
    const cookie = cookieOf(login);
    const body = { slug: "acme", name: "Acme" };

    const evil = client(instance, {
      cookie,
      headers: { origin: "https://evil.example" },
    });
    expect((await evil.call("POST", "/api/orgs", body)).status).toBe(403);
    const crossSite = client(instance, {
      cookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect((await crossSite.call("POST", "/api/orgs", body)).status).toBe(403);

    const sameSite = client(instance, { cookie, headers: { origin: ORIGIN } });
    expect((await sameSite.call("POST", "/api/orgs", body)).status).toBe(201);
    expect((await evil.call("GET", "/api/orgs")).status).toBe(200);
  });
});
