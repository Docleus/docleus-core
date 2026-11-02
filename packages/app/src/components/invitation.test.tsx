import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDom,
  currentPath,
  visit,
  type TestDom,
} from "../test-dom.tsx";
import { InvitationView } from "./invitation.tsx";
import { Setup } from "./setup.tsx";

const TOKEN = "tok-123";
const USER = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  hasPassword: true,
};

let dom: TestDom;

function invitation(email?: string) {
  return {
    org: { id: "o1", name: "Acme" },
    role: "admin",
    email,
    expiresAt: Date.UTC(2026, 10, 2),
  };
}

function signedOut(): void {
  dom.route("GET", "/api/me", () => ({
    status: 401,
    body: { code: "auth/unauthenticated", message: "sign in" },
  }));
}

function methods(): void {
  dom.route("GET", "/api/auth/methods", () => ({
    body: {
      password: true,
      dev: false,
      setupRequired: false,
      providers: [
        {
          id: "oidc.corp",
          display: { label: "Corp", href: "/api/auth/oidc/corp/start" },
        },
      ],
    },
  }));
}

function form(name: string): HTMLFormElement | null {
  return dom.container.querySelector<HTMLFormElement>(
    `form[aria-label="${name}"]`,
  );
}

beforeEach(() => {
  dom = createTestDom();
  visit(`/invitations/${TOKEN}`);
});

afterEach(async () => {
  await dom.dispose();
});

describe("InvitationView", () => {
  it("lets a signed-out visitor sign up with the invitation's email", async () => {
    dom.route("GET", `/api/invitations/${TOKEN}`, () => ({
      body: invitation("ada@example.com"),
    }));
    dom.route("POST", "/api/auth/signup", () => ({
      status: 201,
      body: { user: USER },
    }));
    signedOut();
    methods();
    await dom.render(<InvitationView token={TOKEN} />);

    const signup = await dom.waitFor(() => form("Create account"));
    expect(dom.text()).toContain("join Acme as admin");
    expect(dom.field("Email", signup)).toBeUndefined();
    expect(signup.textContent).toContain("ada@example.com");
    await dom.type(dom.field("Name", signup) as HTMLInputElement, "Ada");
    await dom.type(
      dom.field("Password", signup) as HTMLInputElement,
      "s3cret-pw",
    );
    await dom.submit(signup);

    await dom.waitFor(() => currentPath() === "/orgs/o1");
    expect(dom.calls.find((c) => c.method === "POST")?.body).toEqual({
      invitation: TOKEN,
      name: "Ada",
      password: "s3cret-pw",
    });
  });

  it("asks for an email when the invitation has none", async () => {
    dom.route("GET", `/api/invitations/${TOKEN}`, () => ({
      body: invitation(),
    }));
    dom.route("POST", "/api/auth/signup", () => ({
      status: 201,
      body: { user: USER },
    }));
    signedOut();
    methods();
    await dom.render(<InvitationView token={TOKEN} />);

    const signup = await dom.waitFor(() => form("Create account"));
    await dom.type(dom.field("Name", signup) as HTMLInputElement, "Ada");
    await dom.type(
      dom.field("Email", signup) as HTMLInputElement,
      "ada@example.com",
    );
    await dom.type(
      dom.field("Password", signup) as HTMLInputElement,
      "s3cret-pw",
    );
    await dom.submit(signup);

    await dom.waitFor(() => currentPath() === "/orgs/o1");
    expect(dom.calls.find((c) => c.method === "POST")?.body).toEqual({
      invitation: TOKEN,
      name: "Ada",
      email: "ada@example.com",
      password: "s3cret-pw",
    });
  });

  it("offers sign-in and providers that come back to the invitation", async () => {
    dom.route("GET", `/api/invitations/${TOKEN}`, () => ({
      body: invitation(),
    }));
    signedOut();
    methods();
    await dom.render(<InvitationView token={TOKEN} />);

    const provider = await dom.waitFor(() =>
      dom.container.querySelector<HTMLAnchorElement>(".providers a"),
    );
    expect(provider.getAttribute("href")).toBe(
      `/api/auth/oidc/corp/start?invitation=${TOKEN}&return=%2Finvitations%2F${TOKEN}`,
    );
    const signIn = [...dom.container.querySelectorAll("a")].find(
      (a) => a.textContent === "Sign in",
    );
    expect(signIn?.getAttribute("href")).toBe(
      `/login?return=%2Finvitations%2F${TOKEN}`,
    );
  });

  it("lets a signed-in user accept", async () => {
    dom.route("GET", `/api/invitations/${TOKEN}`, () => ({
      body: invitation(),
    }));
    dom.route("GET", "/api/me", () => ({
      body: { user: USER, isAdmin: false },
    }));
    dom.route("POST", `/api/invitations/${TOKEN}/accept`, () => ({
      body: { org: { id: "o1", name: "Acme" } },
    }));
    methods();
    await dom.render(<InvitationView token={TOKEN} />);

    const accept = await dom.waitFor(() => dom.button("Accept invitation"));
    expect(dom.text()).toContain("Signed in as ada@example.com.");
    expect(form("Create account")).toBeNull();
    await dom.click(accept);
    await dom.waitFor(() => currentPath() === "/orgs/o1");
  });

  it("shows why accepting failed", async () => {
    dom.route("GET", `/api/invitations/${TOKEN}`, () => ({
      body: invitation("someone@example.com"),
    }));
    dom.route("GET", "/api/me", () => ({
      body: { user: USER, isAdmin: false },
    }));
    dom.route("POST", `/api/invitations/${TOKEN}/accept`, () => ({
      status: 403,
      body: {
        code: "invitations/invitation-email-mismatch",
        message: "this invitation is for another email",
      },
    }));
    methods();
    await dom.render(<InvitationView token={TOKEN} />);

    await dom.click(await dom.waitFor(() => dom.button("Accept invitation")));
    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe(
      "this invitation is for another email (invitations/invitation-email-mismatch)",
    );
  });

  it("explains an unknown or used invitation", async () => {
    dom.route("GET", `/api/invitations/${TOKEN}`, () => ({
      status: 404,
      body: { code: "invitations/not-found", message: "not found" },
    }));
    signedOut();
    methods();
    await dom.render(<InvitationView token={TOKEN} />);

    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toContain("does not exist, has expired");
  });
});

describe("Setup", () => {
  it("creates the first administrator with the setup token", async () => {
    visit("/setup?token=from-log");
    dom.route("GET", "/api/setup", () => ({ body: { required: true } }));
    dom.route("POST", "/api/setup", () => ({
      status: 201,
      body: { user: USER },
    }));
    await dom.render(<Setup />);

    const setup = await dom.waitFor(() => form("Set up"));
    expect(dom.field("Setup token", setup)?.value).toBe("from-log");
    await dom.type(dom.field("Name", setup) as HTMLInputElement, "Ada");
    await dom.type(dom.field("Email", setup) as HTMLInputElement, USER.email);
    await dom.type(
      dom.field("Password", setup) as HTMLInputElement,
      "s3cret-pw",
    );
    await dom.submit(setup);

    await dom.waitFor(() => currentPath() === "/");
    expect(dom.calls.find((c) => c.method === "POST")?.body).toEqual({
      token: "from-log",
      name: "Ada",
      email: USER.email,
      password: "s3cret-pw",
    });
  });

  it("shows a wrong token", async () => {
    visit("/setup");
    dom.route("GET", "/api/setup", () => ({ body: { required: true } }));
    dom.route("POST", "/api/setup", () => ({
      status: 403,
      body: { code: "setup/invalid-token", message: "invalid setup token" },
    }));
    await dom.render(<Setup />);

    const setup = await dom.waitFor(() => form("Set up"));
    await dom.type(dom.field("Setup token", setup) as HTMLInputElement, "x");
    await dom.type(dom.field("Name", setup) as HTMLInputElement, "Ada");
    await dom.type(dom.field("Email", setup) as HTMLInputElement, USER.email);
    await dom.type(
      dom.field("Password", setup) as HTMLInputElement,
      "s3cret-pw",
    );
    await dom.submit(setup);
    const alert = await dom.waitFor(() =>
      setup.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe("invalid setup token (setup/invalid-token)");
    expect(currentPath()).toBe("/setup");
  });

  it("points to sign-in once the instance is set up", async () => {
    visit("/setup");
    dom.route("GET", "/api/setup", () => ({ body: { required: false } }));
    await dom.render(<Setup />);
    await dom.waitFor(() =>
      dom.text().includes("already set up") ? true : null,
    );
    expect(form("Set up")).toBeNull();
  });
});
