import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeContext, type Me } from "../lib/auth.tsx";
import { createTestDom, type TestDom } from "../test-dom.tsx";
import { AccountView } from "./account.tsx";
import { UsersSettings } from "./users.tsx";

function me(hasPassword: boolean, isAdmin = false): Me {
  return {
    user: { id: "u1", email: "ada@example.com", name: "Ada", hasPassword },
    isAdmin,
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

describe("AccountView", () => {
  it("changes the password with the current one", async () => {
    dom.route("PUT", "/api/me/password", () => ({ body: { user: {} } }));
    const onChange = vi.fn();
    await dom.render(
      <MeContext value={me(true)}>
        <AccountView onChange={onChange} />
      </MeContext>,
    );

    const change = (await dom.waitFor(() =>
      form("Change password"),
    )) as HTMLFormElement;
    await dom.type(
      dom.field("Current password", change) as HTMLInputElement,
      "old-password",
    );
    await dom.type(
      dom.field("New password", change) as HTMLInputElement,
      "new-password",
    );
    await dom.type(
      dom.field("Confirm new password", change) as HTMLInputElement,
      "new-password",
    );
    await dom.submit(change);

    await dom.waitFor(() =>
      dom.text().includes("Password changed.") ? true : null,
    );
    expect(dom.calls.find((c) => c.method === "PUT")?.body).toEqual({
      current: "old-password",
      password: "new-password",
    });
    expect(onChange).toHaveBeenCalled();
    expect(dom.field("New password", change)?.value).toBe("");
  });

  it("sets a first password without asking for a current one", async () => {
    dom.route("PUT", "/api/me/password", () => ({ body: { user: {} } }));
    await dom.render(
      <MeContext value={me(false)}>
        <AccountView onChange={() => {}} />
      </MeContext>,
    );

    const set = (await dom.waitFor(() =>
      form("Set a password"),
    )) as HTMLFormElement;
    expect(dom.field("Current password", set)).toBeUndefined();
    await dom.type(
      dom.field("New password", set) as HTMLInputElement,
      "new-password",
    );
    await dom.type(
      dom.field("Confirm new password", set) as HTMLInputElement,
      "new-password",
    );
    await dom.submit(set);
    await dom.waitFor(() => dom.calls.find((c) => c.method === "PUT"));
    expect(dom.calls.find((c) => c.method === "PUT")?.body).toEqual({
      password: "new-password",
    });
  });

  it("refuses mismatched passwords and shows server errors", async () => {
    dom.route("PUT", "/api/me/password", () => ({
      status: 401,
      body: {
        code: "account/wrong-password",
        message: "the current password is wrong",
      },
    }));
    await dom.render(
      <MeContext value={me(true)}>
        <AccountView onChange={() => {}} />
      </MeContext>,
    );

    const change = (await dom.waitFor(() =>
      form("Change password"),
    )) as HTMLFormElement;
    await dom.type(
      dom.field("Current password", change) as HTMLInputElement,
      "wrong-password",
    );
    await dom.type(
      dom.field("New password", change) as HTMLInputElement,
      "new-password",
    );
    await dom.type(
      dom.field("Confirm new password", change) as HTMLInputElement,
      "other-password",
    );
    expect(change.querySelector('[role="alert"]')?.textContent).toBe(
      "The passwords do not match.",
    );
    expect(dom.button("Save password")?.disabled).toBe(true);

    await dom.type(
      dom.field("Confirm new password", change) as HTMLInputElement,
      "new-password",
    );
    await dom.submit(change);
    const alert = await dom.waitFor(() =>
      change.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe(
      "the current password is wrong (account/wrong-password)",
    );
  });
});

describe("UsersSettings", () => {
  it("toggles the instance admin role", async () => {
    const users = [
      { id: "u1", email: "ada@example.com", name: "Ada", isAdmin: true },
      { id: "u2", email: "bob@example.com", name: "Bob", isAdmin: false },
    ];
    dom.route("GET", "/api/users", () => ({ body: { users } }));
    dom.route("PUT", "/api/users/u2/admin", (call) => {
      const isAdmin = (call.body as { isAdmin: boolean }).isAdmin;
      users[1] = { ...users[1], id: "u2", isAdmin } as (typeof users)[number];
      return { body: {} };
    });
    dom.route("PUT", "/api/users/u1/admin", () => ({
      status: 409,
      body: {
        code: "users/last-admin",
        message: "the instance needs an admin",
      },
    }));
    await dom.render(
      <MeContext value={me(true, true)}>
        <UsersSettings />
      </MeContext>,
    );

    const bob = (await dom.waitFor(() =>
      dom.field("Instance admin: bob@example.com"),
    )) as HTMLInputElement;
    expect(dom.text()).toContain("Ada (you)");
    expect(bob.checked).toBe(false);
    await dom.click(bob);
    await dom.waitFor(() =>
      dom.text().includes("bob@example.com is now an instance admin.")
        ? true
        : null,
    );
    expect(
      dom.calls.find((c) => c.path === "/api/users/u2/admin")?.body,
    ).toEqual({ isAdmin: true });
    await dom.waitFor(
      () =>
        (dom.field("Instance admin: bob@example.com") as HTMLInputElement)
          .checked,
    );

    await dom.click(
      dom.field("Instance admin: ada@example.com") as HTMLInputElement,
    );
    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe(
      "the instance needs an admin (users/last-admin)",
    );
    await dom.waitFor(
      () =>
        (dom.field("Instance admin: ada@example.com") as HTMLInputElement)
          .checked,
    );
  });
});
