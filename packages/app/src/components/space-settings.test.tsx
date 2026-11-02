import { Context, type Space } from "@docleus/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostContext, type Host } from "../lib/host.tsx";
import { createToastStore } from "../lib/toasts.ts";
import { createUiService } from "../lib/ui-service.ts";
import { createTestDom, type TestDom } from "../test-dom.tsx";
import type { SiteStatus } from "./publish.tsx";
import { SpaceSettings } from "./space-settings.tsx";

const SPACE: Space = { id: "s1", orgId: "o1", slug: "guide", name: "Guide" };
const SITE = "/api/orgs/o1/sites/site1";
const HOUR = 3_600_000;

function status(overrides: Partial<SiteStatus> = {}): SiteStatus {
  const now = Date.now();
  return {
    site: {
      id: "site1",
      orgId: "o1",
      slug: "guide",
      name: "Guide",
      spaces: [{ spaceId: "s1", path: "" }],
      theme: undefined,
      domain: undefined,
      active: "pub2",
      url: "/sites/acme/guide/",
    },
    canPublish: true,
    head: "rev2",
    live: { publication: "pub2", revision: "rev2", at: now - HOUR },
    pending: [],
    history: [
      {
        publication: "pub2",
        revision: "rev2",
        at: now - HOUR,
        by: "u1",
        byName: "Ada",
      },
      {
        publication: "pub1",
        revision: "rev1",
        at: now - 3 * 24 * HOUR,
        by: "u1",
        byName: "Ada",
      },
    ],
    ...overrides,
  };
}

let dom: TestDom;
let host: Host;
let siteChanges: number;

beforeEach(() => {
  dom = createTestDom();
  const root = new Context();
  host = {
    root,
    ui: createUiService(root),
    loader: { urls: [], apply: async () => undefined },
    toasts: createToastStore(),
  };
  siteChanges = 0;
  dom.route("GET", "/api/orgs/o1/spaces/s1/members", () => ({
    body: { members: [] },
  }));
  dom.route("GET", "/api/orgs/o1/members", () => ({ body: { members: [] } }));
  dom.route("GET", "/api/orgs/o1/spaces/s1/plugins", () => ({
    body: { plugins: [] },
  }));
});

afterEach(async () => {
  await dom.dispose();
});

async function render(site: SiteStatus): Promise<void> {
  await dom.render(
    <HostContext value={host}>
      <SpaceSettings
        orgId="o1"
        space={SPACE}
        section=""
        site={site}
        onSiteChange={() => siteChanges++}
        onSpaceChange={() => undefined}
        onPluginsChange={() => undefined}
      />
    </HostContext>,
  );
}

const siteSection = () => {
  const section = dom.container.querySelector<HTMLElement>("#site");
  if (!section) throw new Error("no Site section");
  return section;
};

describe("SpaceSettings", () => {
  it("names the live site in words and lists history newest first", async () => {
    await render(status());
    const section = siteSection();
    expect(section.querySelector(".section-tag")?.textContent).toBe("Live");
    const rows = [...section.querySelectorAll(".history li")].map((row) =>
      row.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows[0]).toMatch(/^1 hour ago/);
    expect(rows[0]).toContain("Ada");
    expect(rows[0]).toContain("Live");
    expect(rows[1]).toMatch(/^3 days ago/);
    expect(rows[1]).toContain("Roll back");
  });

  it("saves and clears the custom domain", async () => {
    dom.route("PATCH", SITE, () => ({ body: { site: {} } }));
    await render(status());
    const input = siteSection().querySelector<HTMLInputElement>("#site-domain");
    if (!input) throw new Error("no domain field");
    await dom.type(input, "docs.example.com");
    const save = dom.button("Save");
    if (!save) throw new Error("no Save");
    await dom.click(save);
    expect(dom.calls.filter((call) => call.method === "PATCH")).toMatchObject([
      { method: "PATCH", path: SITE, body: { domain: "docs.example.com" } },
    ]);
    expect(siteChanges).toBe(1);
  });

  it("clears a saved custom domain", async () => {
    dom.route("PATCH", SITE, () => ({ body: { site: {} } }));
    const saved = status();
    await render({
      ...saved,
      site: saved.site && { ...saved.site, domain: "docs.example.com" },
    });
    expect(dom.button("Save")).toBeUndefined();
    const input = siteSection().querySelector<HTMLInputElement>("#site-domain");
    if (!input) throw new Error("no domain field");
    await dom.type(input, "");
    await dom.click(dom.button("Save") as HTMLButtonElement);
    expect(dom.calls.filter((call) => call.method === "PATCH")).toMatchObject([
      { body: { domain: null } },
    ]);
  });

  it("rolls back to an older publication", async () => {
    dom.route("POST", `${SITE}/activate`, () => ({ body: { site: {} } }));
    await render(status());
    await dom.click(dom.button("Roll back") as HTMLButtonElement);
    expect(dom.calls.filter((call) => call.method === "POST")).toMatchObject([
      {
        method: "POST",
        path: `${SITE}/activate`,
        body: { publication: "pub1" },
      },
    ]);
    expect(siteChanges).toBe(1);
  });

  it("unpublishes only after the confirmation", async () => {
    dom.route("DELETE", SITE, () => ({ status: 204 }));
    await render(status());
    await dom.click(dom.button("Unpublish site") as HTMLButtonElement);
    await dom.click(dom.button("Cancel") as HTMLButtonElement);
    expect(dom.calls.some((call) => call.method === "DELETE")).toBe(false);

    await dom.click(dom.button("Unpublish site") as HTMLButtonElement);
    await dom.click(dom.button("Unpublish") as HTMLButtonElement);
    await dom.waitFor(() => dom.calls.some((call) => call.method === "DELETE"));
    expect(siteChanges).toBe(1);
  });

  it("creates and publishes the site of an unpublished space", async () => {
    dom.route("POST", "/api/orgs/o1/sites", () => ({
      status: 201,
      body: { site: { id: "site1" } },
    }));
    dom.route("POST", `${SITE}/publications`, () => ({
      status: 201,
      body: {},
    }));
    await render({ site: null, canPublish: true, head: "rev1" });
    expect(siteSection().querySelector(".section-tag")?.textContent).toBe(
      "Not published",
    );
    await dom.click(dom.button("Publish") as HTMLButtonElement);
    await dom.waitFor(() => siteChanges === 1);
    expect(
      dom.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.path),
    ).toEqual(["/api/orgs/o1/sites", `${SITE}/publications`]);
  });

  it("shows the description in a multi-line field", async () => {
    await render(status());
    expect(dom.container.querySelector("#space-description")?.tagName).toBe(
      "TEXTAREA",
    );
  });
});
