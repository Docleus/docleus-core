import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthMethods } from "../lib/auth.tsx";
import {
  createTestDom,
  currentPath,
  visit,
  type TestDom,
} from "../test-dom.tsx";
import { Login } from "./login.tsx";

const USER = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  hasPassword: true,
};

function methods(overrides: Partial<AuthMethods> = {}): AuthMethods {
  return {
    password: true,
    dev: false,
    providers: [],
    setupRequired: false,
    ...overrides,
  };
}

let dom: TestDom;

beforeEach(() => {
  dom = createTestDom();
});

afterEach(async () => {
  await dom.dispose();
});

function form(name: string): HTMLFormElement | null {
  return dom.container.querySelector<HTMLFormElement>(
    `form[aria-label="${name}"]`,
  );
}

describe("Login", () => {
  it("signs in with a password and returns to the requested path", async () => {
    visit("/login?return=%2Forgs%2Fo1");
    dom.route("GET", "/api/auth/methods", () => ({ body: methods() }));
    dom.route("POST", "/api/auth/login", () => ({ body: { user: USER } }));
    await dom.render(<Login />);

    const login = await dom.waitFor(() => form("Sign in with password"));
    await dom.type(dom.field("Email", login) as HTMLInputElement, USER.email);
    await dom.type(
      dom.field("Password", login) as HTMLInputElement,
      "hunter22",
    );
    await dom.submit(login);

    await dom.waitFor(() => currentPath() === "/orgs/o1");
    const call = dom.calls.find((c) => c.path === "/api/auth/login");
    expect(call?.body).toEqual({ email: USER.email, password: "hunter22" });
    expect(call?.credentials).toBe("same-origin");
  });

  it("never returns to another origin", async () => {
    visit("/login?return=%2F%2Fevil.test%2F");
    dom.route("GET", "/api/auth/methods", () => ({ body: methods() }));
    dom.route("POST", "/api/auth/login", () => ({ body: { user: USER } }));
    await dom.render(<Login />);

    const login = await dom.waitFor(() => form("Sign in with password"));
    await dom.type(dom.field("Email", login) as HTMLInputElement, USER.email);
    await dom.type(
      dom.field("Password", login) as HTMLInputElement,
      "hunter22",
    );
    await dom.submit(login);
    await dom.waitFor(() => currentPath() === "/");
  });

  it("explains wrong credentials and rate limiting", async () => {
    visit("/login");
    let status = 401;
    dom.route("GET", "/api/auth/methods", () => ({ body: methods() }));
    dom.route("POST", "/api/auth/login", () => ({
      status,
      body: {
        code: status === 401 ? "auth/invalid-credentials" : "auth/rate-limited",
        message: "nope",
      },
    }));
    await dom.render(<Login />);

    const login = await dom.waitFor(() => form("Sign in with password"));
    await dom.type(dom.field("Email", login) as HTMLInputElement, USER.email);
    await dom.type(
      dom.field("Password", login) as HTMLInputElement,
      "wrong-one",
    );
    await dom.submit(login);
    const alert = await dom.waitFor(() =>
      login.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe("Wrong email or password.");

    status = 429;
    await dom.submit(login);
    await dom.waitFor(() =>
      login.querySelector('[role="alert"]')?.textContent?.startsWith("Too many")
        ? true
        : null,
    );
    expect(currentPath()).toBe("/login");
  });

  it("keeps the development form when the instance runs with --dev", async () => {
    visit("/login");
    dom.route("GET", "/api/auth/methods", () => ({
      body: methods({ password: true, dev: true }),
    }));
    dom.route("POST", "/api/auth/dev-login", () => ({
      body: { user: USER, token: "t" },
    }));
    await dom.render(<Login />);

    const dev = await dom.waitFor(() => form("Development sign-in"));
    await dom.type(dom.field("Email", dev) as HTMLInputElement, USER.email);
    await dom.submit(dev);
    await dom.waitFor(() => currentPath() === "/?landing=1");
    expect(dom.calls.find((c) => c.method === "POST")?.body).toEqual({
      email: USER.email,
    });
  });

  it("links each provider with the return path", async () => {
    visit("/login?return=%2Forgs%2Fo1");
    dom.route("GET", "/api/auth/methods", () => ({
      body: methods({
        password: false,
        providers: [
          {
            id: "oidc.corp",
            display: { label: "Corp SSO", href: "/api/auth/oidc/corp/start" },
          },
        ],
      }),
    }));
    await dom.render(<Login />);

    const link = await dom.waitFor(() =>
      dom.container.querySelector<HTMLAnchorElement>(".providers a"),
    );
    expect(link.textContent).toBe("Sign in with Corp SSO");
    expect(link.getAttribute("href")).toBe(
      "/api/auth/oidc/corp/start?return=%2Forgs%2Fo1",
    );
    expect(form("Sign in with password")).toBeNull();
  });

  it("shows redirect error codes in words", async () => {
    visit("/login?error=oidc-email-unverified");
    dom.route("GET", "/api/auth/methods", () => ({ body: methods() }));
    await dom.render(<Login />);

    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toContain("has not verified the email");

    visit("/login?error=something-new");
    await dom.render(<Login />);
    await dom.waitFor(() =>
      dom.text().includes("Sign-in failed (something-new).") ? true : null,
    );
  });

  it("sends a fresh instance to setup", async () => {
    visit("/login");
    dom.route("GET", "/api/auth/methods", () => ({
      body: methods({ setupRequired: true }),
    }));
    await dom.render(<Login />);
    await dom.waitFor(() => currentPath() === "/setup");
  });

  it("says so when no sign-in method is configured", async () => {
    visit("/login");
    dom.route("GET", "/api/auth/methods", () => ({
      body: methods({ password: false }),
    }));
    await dom.render(<Login />);
    await dom.waitFor(() =>
      dom.text().includes("No sign-in method is configured") ? true : null,
    );
  });
});
