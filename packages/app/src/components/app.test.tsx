import { Context } from "@docleus/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostContext, type Host } from "../lib/host.tsx";
import { createUiService } from "../lib/ui-service.ts";
import {
  createTestDom,
  currentPath,
  visit,
  type TestDom,
} from "../test-dom.tsx";
import { App } from "./app.tsx";
import { createToastStore } from "../lib/toasts.ts";

const ADMIN = {
  user: { id: "u1", email: "ada@example.com", name: "Ada", hasPassword: true },
  isAdmin: true,
};

let dom: TestDom;

function host(): Host {
  const root = new Context();
  return {
    root,
    ui: createUiService(root),
    loader: {} as Host["loader"],
    toasts: createToastStore(),
  };
}

async function renderApp(): Promise<void> {
  await dom.render(
    <HostContext value={host()}>
      <App />
    </HostContext>,
  );
}

function tabs(): string[] {
  return [
    ...dom.container.querySelectorAll(
      'nav[aria-label="Settings"] a:not(.back)',
    ),
  ].map((tab) => tab.textContent ?? "");
}

function currentTab(): string | null | undefined {
  return dom.container.querySelector(
    'nav[aria-label="Settings"] a[aria-current="page"]',
  )?.textContent;
}

beforeEach(() => {
  dom = createTestDom();
});

afterEach(async () => {
  await dom.dispose();
});

describe("App", () => {
  it("sends a signed-out visitor to sign-in with the return path", async () => {
    visit("/orgs/o1/settings/members?x=1");
    dom.route("GET", "/api/me", () => ({
      status: 401,
      body: { code: "auth/unauthenticated", message: "sign in" },
    }));
    dom.route("GET", "/api/auth/methods", () => ({
      body: { password: true, dev: false, providers: [], setupRequired: false },
    }));
    await renderApp();

    await dom.waitFor(() => currentPath().startsWith("/login"));
    expect(currentPath()).toBe(
      "/login?return=%2Forgs%2Fo1%2Fsettings%2Fmembers%3Fx%3D1",
    );
    await dom.waitFor(() =>
      dom.container.querySelector('form[aria-label="Sign in with password"]'),
    );
  });

  it("opens the Users tab of the instance settings by default", async () => {
    visit("/settings");
    dom.route("GET", "/api/me", () => ({ body: ADMIN }));
    dom.route("GET", "/api/users", () => ({
      body: { users: [{ ...ADMIN.user, isAdmin: true }] },
    }));
    await renderApp();

    await dom.waitFor(() => dom.field("Instance admin: ada@example.com"));
    expect(tabs()).toEqual(["Users", "Installed plugins"]);
    expect(currentTab()).toBe("Users");
    expect(
      dom.container.querySelector('button[aria-label="Account"]')?.textContent,
    ).toContain(ADMIN.user.name || ADMIN.user.email);
  });

  it("shows the Members tab in organization settings", async () => {
    visit("/orgs/o1/settings/members");
    dom.route("GET", "/api/me", () => ({ body: ADMIN }));
    dom.route("GET", "/api/orgs/o1/members", () => ({
      body: { members: [{ user: ADMIN.user, role: "owner" }] },
    }));
    dom.route("GET", "/api/orgs/o1/invitations", () => ({
      body: { invitations: [] },
    }));
    await renderApp();

    await dom.waitFor(() =>
      dom.container.querySelector('table[aria-label="Organization members"]'),
    );
    expect(tabs()).toEqual([
      "General",
      "Members",
      "Sites",
      "Plugins",
      "Users",
      "Installed plugins",
    ]);
    expect(currentTab()).toBe("Members");
  });

  it("serves the account page", async () => {
    visit("/account");
    dom.route("GET", "/api/me", () => ({ body: ADMIN }));
    await renderApp();
    await dom.waitFor(() =>
      dom.container.querySelector('form[aria-label="Change password"]'),
    );
  });

  it("loads the plugin frontends before resolving a full-page app opened directly", async () => {
    visit("/apps/acme/o1/s1");
    const root = new Context();
    const ui = createUiService(root);
    const applied: unknown[] = [];
    const loader: Host["loader"] = {
      urls: [],
      apply: async (entries) => {
        applied.push(entries);
        ui.registerApp({
          path: "acme",
          label: "Acme",
          component: (props: { path: string }) => <p>Acme at {props.path}</p>,
        });
      },
    };
    const editors = [{ name: "@acme/plugin", url: "/_plugins/acme.js" }];
    dom.route("GET", "/api/me", () => ({ body: ADMIN }));
    dom.route("GET", "/api/frontend", () => ({ body: { editors } }));
    await dom.render(
      <HostContext value={{ root, ui, loader, toasts: createToastStore() }}>
        <App />
      </HostContext>,
    );

    const page = await dom.waitFor(() =>
      [...dom.container.querySelectorAll("p")].find((p) =>
        p.textContent?.startsWith("Acme"),
      ),
    );
    expect(page.textContent).toBe("Acme at o1/s1");
    expect(applied).toEqual([editors]);
    expect(dom.container.textContent).not.toContain("No app");
  });

  it("shows the org home's plugin sections when it is opened directly", async () => {
    visit("/orgs/o1");
    const root = new Context();
    const ui = createUiService(root);
    const applied: unknown[] = [];
    const loader: Host["loader"] = {
      urls: [],
      apply: async (entries) => {
        applied.push(entries);
        ui.registerSlot("org.home", {
          id: "waiting",
          component: () => <p>Waiting for you</p>,
        });
      },
    };
    const editors = [{ name: "@acme/plugin", url: "/_plugins/acme.js" }];
    dom.route("GET", "/api/me", () => ({ body: ADMIN }));
    dom.route("GET", "/api/orgs", () => ({ body: { orgs: [] } }));
    dom.route("GET", "/api/orgs/o1", () => ({
      body: {
        org: { id: "o1", slug: "acme", name: "Acme" },
        spaces: [{ id: "s1", orgId: "o1", slug: "docs", name: "Docs" }],
      },
    }));
    dom.route("GET", "/api/orgs/o1/sites", () => ({ body: { sites: [] } }));
    dom.route("GET", "/api/orgs/o1/frontend", () => ({ body: { editors } }));
    await dom.render(
      <HostContext value={{ root, ui, loader, toasts: createToastStore() }}>
        <App />
      </HostContext>,
    );

    await dom.waitFor(() =>
      [...dom.container.querySelectorAll("p")].find(
        (p) => p.textContent === "Waiting for you",
      ),
    );
    expect(applied).toEqual([editors]);
  });

  it("says when no plugin provides the app", async () => {
    visit("/apps/nothing");
    dom.route("GET", "/api/me", () => ({ body: ADMIN }));
    dom.route("GET", "/api/frontend", () => ({ body: { editors: [] } }));
    const root = new Context();
    await dom.render(
      <HostContext
        value={{
          root,
          ui: createUiService(root),
          loader: { urls: [], apply: async () => undefined },
          toasts: createToastStore(),
        }}
      >
        <App />
      </HostContext>,
    );
    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe("No app at /apps/nothing.");
  });
});
