import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeContext, type Me } from "../lib/auth.tsx";
import {
  createTestDom,
  currentPath,
  visit,
  type TestDom,
} from "../test-dom.tsx";
import { OrgMembers, SpaceMembers } from "./members.tsx";

const ORG = "/api/orgs/o1";
const SPACE = `${ORG}/spaces/s1`;

function user(id: string, email: string, name = id) {
  return { id, email, name };
}

const ADA = user("u1", "ada@example.com", "Ada");
const BOB = user("u2", "bob@example.com", "Bob");
const CY = user("u3", "cy@example.com", "Cy");

function me(id: string, isAdmin = false): Me {
  return {
    user: { id, email: `${id}@example.com`, name: id, hasPassword: true },
    isAdmin,
  };
}

let dom: TestDom;

beforeEach(() => {
  dom = createTestDom();
  visit("/orgs/o1/settings/members");
});

afterEach(async () => {
  await dom.dispose();
});

function form(name: string): HTMLFormElement | null {
  return dom.container.querySelector<HTMLFormElement>(
    `form[aria-label="${name}"]`,
  );
}

async function renderOrg(as: Me): Promise<void> {
  await dom.render(
    <MeContext value={as}>
      <OrgMembers orgId="o1" />
    </MeContext>,
  );
}

describe("OrgMembers", () => {
  it("lists members and changes a role", async () => {
    let bobRole = "member";
    dom.route("GET", `${ORG}/members`, () => ({
      body: {
        members: [
          { user: ADA, role: "owner" },
          { user: BOB, role: bobRole },
        ],
      },
    }));
    dom.route("GET", `${ORG}/invitations`, () => ({
      body: { invitations: [] },
    }));
    dom.route("PUT", `${ORG}/members/u2`, (call) => {
      bobRole = (call.body as { role: string }).role;
      return { body: {} };
    });
    await renderOrg(me("u1"));

    const select = (await dom.waitFor(() =>
      dom.field("Role of bob@example.com"),
    )) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "owner",
      "admin",
      "member",
    ]);
    await dom.type(select, "admin");

    await dom.waitFor(() =>
      dom.text().includes("bob@example.com is now admin.") ? true : null,
    );
    expect(dom.calls.find((c) => c.method === "PUT")?.body).toEqual({
      role: "admin",
    });
    expect(
      (dom.field("Role of bob@example.com") as HTMLSelectElement).value,
    ).toBe("admin");
    expect(dom.text()).toContain("No pending invitations.");
  });

  it("lets an org admin manage members but not owners", async () => {
    dom.route("GET", `${ORG}/members`, () => ({
      body: {
        members: [
          { user: ADA, role: "owner" },
          { user: { ...BOB, id: "u2" }, role: "admin" },
          { user: CY, role: "member" },
        ],
      },
    }));
    dom.route("GET", `${ORG}/invitations`, () => ({
      body: { invitations: [] },
    }));
    await renderOrg(me("u2"));

    const cy = (await dom.waitFor(() =>
      dom.field("Role of cy@example.com"),
    )) as HTMLSelectElement;
    expect([...cy.options].map((option) => option.value)).toEqual([
      "admin",
      "member",
    ]);
    expect(dom.field("Role of ada@example.com")).toBeUndefined();
    expect(dom.button("Remove ada@example.com")).toBeUndefined();
    expect(dom.button("Leave organization")).toBeDefined();
  });

  it("shows a read-only list to a plain member", async () => {
    dom.route("GET", `${ORG}/members`, () => ({
      body: {
        members: [
          { user: ADA, role: "owner" },
          { user: CY, role: "member" },
        ],
      },
    }));
    await renderOrg(me("u3"));

    await dom.waitFor(() =>
      dom.container.querySelector('table[aria-label="Organization members"]'),
    );
    expect(dom.container.querySelector("select")).toBeNull();
    expect(form("Invite")).toBeNull();
    expect(dom.button("Leave organization")).toBeDefined();
    expect(dom.calls.some((c) => c.path === `${ORG}/invitations`)).toBe(false);
  });

  it("shows the last-owner conflict", async () => {
    dom.route("GET", `${ORG}/members`, () => ({
      body: { members: [{ user: ADA, role: "owner" }] },
    }));
    dom.route("GET", `${ORG}/invitations`, () => ({
      body: { invitations: [] },
    }));
    dom.route("DELETE", `${ORG}/members/u1`, () => ({
      status: 409,
      body: {
        code: "members/last-owner",
        message: "an organization needs an owner",
      },
    }));
    await renderOrg(me("u1"));

    await dom.click(await dom.waitFor(() => dom.button("Leave organization")));
    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe(
      "an organization needs an owner (members/last-owner)",
    );
    expect(currentPath()).toBe("/orgs/o1/settings/members");
  });

  it("invites, shows the link to copy, and revokes", async () => {
    let invitations: unknown[] = [];
    dom.route("GET", `${ORG}/members`, () => ({
      body: { members: [{ user: ADA, role: "owner" }] },
    }));
    dom.route("GET", `${ORG}/invitations`, () => ({
      body: { invitations },
    }));
    dom.route("POST", `${ORG}/invitations`, (call) => {
      const body = call.body as { email?: string; role: string };
      invitations = [
        {
          id: "i1",
          email: body.email,
          role: body.role,
          createdAt: Date.UTC(2026, 9, 26),
          expiresAt: Date.UTC(2026, 10, 2),
        },
      ];
      return {
        status: 201,
        body: {
          invitation: invitations[0],
          url: "http://docs.test/invitations/secret",
          emailed: false,
        },
      };
    });
    dom.route("DELETE", `${ORG}/invitations/i1`, () => {
      invitations = [];
      return { body: {} };
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await renderOrg(me("u1"));

    const invite = await dom.waitFor(() => form("Invite"));
    await dom.type(
      dom.field("Email", invite) as HTMLInputElement,
      " bob@example.com ",
    );
    await dom.type(dom.field("Role", invite) as HTMLSelectElement, "admin");
    await dom.submit(invite);

    const link = (await dom.waitFor(() =>
      dom.field("Invitation link"),
    )) as HTMLInputElement;
    expect(link.value).toBe("http://docs.test/invitations/secret");
    expect(dom.text()).toContain("Copy the link and send it.");
    expect(dom.calls.find((c) => c.method === "POST")?.body).toEqual({
      email: "bob@example.com",
      role: "admin",
    });
    await dom.click(dom.button("Copy link") as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith(
      "http://docs.test/invitations/secret",
    );
    await dom.waitFor(() =>
      dom.text().includes("Link copied.") ? true : null,
    );

    const revoke = await dom.waitFor(() =>
      dom.button("Revoke invitation for bob@example.com"),
    );
    await dom.click(revoke);
    await dom.waitFor(() =>
      dom.text().includes("No pending invitations.") ? true : null,
    );
  });

  it("invites without an email and says when the email was sent", async () => {
    dom.route("GET", `${ORG}/members`, () => ({
      body: { members: [{ user: ADA, role: "owner" }] },
    }));
    dom.route("GET", `${ORG}/invitations`, () => ({
      body: { invitations: [] },
    }));
    let emailed = false;
    dom.route("POST", `${ORG}/invitations`, () => ({
      status: 201,
      body: { invitation: {}, url: "http://docs.test/i/x", emailed },
    }));
    await renderOrg(me("u1", true));

    const invite = await dom.waitFor(() => form("Invite"));
    await dom.submit(invite);
    await dom.waitFor(() => dom.field("Invitation link"));
    expect(dom.calls.find((c) => c.method === "POST")?.body).toEqual({
      role: "member",
    });

    emailed = true;
    await dom.type(
      dom.field("Email", invite) as HTMLInputElement,
      "cy@example.com",
    );
    await dom.submit(invite);
    await dom.waitFor(() =>
      dom.text().includes("Invitation emailed to cy@example.com.")
        ? true
        : null,
    );
  });
});

describe("SpaceMembers", () => {
  it("adds an org member, changes and removes the grant", async () => {
    let grants: { user: typeof ADA; role: string }[] = [
      { user: ADA, role: "admin" },
    ];
    dom.route("GET", `${SPACE}/members`, () => ({
      body: { members: grants },
    }));
    dom.route("GET", `${ORG}/members`, () => ({
      body: {
        members: [
          { user: ADA, role: "member" },
          { user: BOB, role: "member" },
          { user: CY, role: "member" },
        ],
      },
    }));
    const put = (target: typeof ADA) => (call: { body: unknown }) => {
      const role = (call.body as { role: string }).role;
      grants = [
        ...grants.filter((grant) => grant.user.id !== target.id),
        { user: target, role },
      ];
      return { body: {} };
    };
    dom.route("PUT", `${SPACE}/members/u3`, put(CY));
    dom.route("PUT", `${SPACE}/members/u1`, put(ADA));
    dom.route("DELETE", `${SPACE}/members/u1`, () => {
      grants = grants.filter((grant) => grant.user.id !== "u1");
      return { body: {} };
    });
    await dom.render(<SpaceMembers orgId="o1" spaceId="s1" />);

    const add = await dom.waitFor(() => form("Add member"));
    const candidate = dom.field("Member", add) as HTMLSelectElement;
    expect([...candidate.options].map((option) => option.value)).toEqual([
      "",
      "u2",
      "u3",
    ]);
    expect(candidate.value).toBe("");
    expect(
      add.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    await dom.type(candidate, "u3");
    await dom.type(dom.field("Role", add) as HTMLSelectElement, "viewer");
    await dom.submit(add);
    await dom.waitFor(() => dom.field("Role of cy@example.com"));
    expect(
      dom.calls.find((c) => c.path === `${SPACE}/members/u3`)?.body,
    ).toEqual({ role: "viewer" });

    await dom.type(
      dom.field("Role of ada@example.com") as HTMLSelectElement,
      "editor",
    );
    await dom.waitFor(() =>
      dom.text().includes("ada@example.com is now editor.") ? true : null,
    );

    await dom.click(dom.button("Remove ada@example.com") as HTMLButtonElement);
    await dom.waitFor(() =>
      dom.text().includes("Removed ada@example.com.") ? true : null,
    );
    expect(dom.field("Role of ada@example.com")).toBeUndefined();
  });

  it("shows a forbidden list as an error", async () => {
    dom.route("GET", `${SPACE}/members`, () => ({
      status: 403,
      body: { code: "authz/forbidden", message: "forbidden" },
    }));
    dom.route("GET", `${ORG}/members`, () => ({ body: { members: [] } }));
    await dom.render(<SpaceMembers orgId="o1" spaceId="s1" />);
    const alert = await dom.waitFor(() =>
      dom.container.querySelector('[role="alert"]'),
    );
    expect(alert.textContent).toBe("forbidden (authz/forbidden)");
  });
});
