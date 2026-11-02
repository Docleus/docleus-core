import { act, useState } from "react";
import { Context, type BlockNode, type PageEditorProps } from "@docleus/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostContext, type Host } from "../lib/host.tsx";
import { createUiService, type HostUiService } from "../lib/ui-service.ts";
import {
  createTestDom,
  currentPath,
  visit,
  type TestDom,
} from "../test-dom.tsx";
import { App } from "./app.tsx";
import { createToastStore } from "../lib/toasts.ts";

const SPACE = "/api/orgs/o1/spaces/s1";
const PAGE = `${SPACE}/pages/p1`;
const CR = "branch=cr%2F1";

const ME = {
  user: { id: "u1", email: "ada@example.com", name: "Ada", hasPassword: true },
  isAdmin: false,
};

function body(text: string): BlockNode {
  return {
    id: "root",
    type: "doc",
    v: 1,
    attrs: {},
    content: [
      {
        id: "b1",
        type: "paragraph",
        v: 1,
        attrs: {},
        inline: [{ type: "text", text }],
      },
    ],
  };
}

function branch(name: string, head: string | null) {
  return {
    spaceId: "s1",
    name,
    head: head ?? undefined,
    base: name === "main" ? undefined : "r1",
    createdAt: 1,
  };
}

let dom: TestDom;
let ui: HostUiService;
let mounts: number;

/** Records what the host passes and saves on demand. */
function TestEditor(props: PageEditorProps) {
  const [isMounted] = useState(() => ++mounts);
  const [status, setStatus] = useState("");
  const save = (text: string) => {
    props.save({ text }).then(
      () => setStatus(`saved ${text}`),
      (error: unknown) =>
        setStatus(`failed ${error instanceof Error ? error.message : ""}`),
    );
  };
  return (
    <section aria-label="Test editor">
      <output aria-label="Editor branch">{props.branch}</output>
      <output aria-label="Editor mount">{isMounted}</output>
      <output aria-label="Save status">{status}</output>
      <button type="button" onClick={() => save("one")}>
        Save one
      </button>
      <button type="button" onClick={() => save("two")}>
        Save two
      </button>
    </section>
  );
}

function host(): Host {
  const root = new Context();
  ui = createUiService(root);
  root.provide("ui", ui);
  ui.registerSlot("page.editor", { id: "test", component: TestEditor });
  return {
    root,
    ui,
    loader: { apply: async () => undefined, urls: [] },
    toasts: createToastStore(),
  };
}

function routeSpace(name: string, query: string, head: string | null): void {
  const suffix = query === "" ? "" : `?${query}`;
  dom.route("GET", `${SPACE}${suffix}`, () => ({
    body: {
      space: { id: "s1", orgId: "o1", slug: "s", name: "Guide" },
      branch: branch(name, head),
      head,
      pages: [
        { id: "p1", title: "Intro", parent: null, order: 1 },
        { id: "p2", title: "Usage", parent: null, order: 2 },
      ],
      canWrite: true,
    },
  }));
  dom.route("GET", `${PAGE}${suffix}`, () => ({
    body: {
      page: {
        id: "p1",
        type: "page",
        title: "Intro",
        parent: undefined,
        order: 1,
        fields: {},
        body: body(name),
      },
      head,
    },
  }));
}

async function renderApp(): Promise<void> {
  await dom.render(
    <HostContext value={host()}>
      <App />
    </HostContext>,
  );
}

function output(label: string): string {
  return (
    dom.container.querySelector(`output[aria-label="${label}"]`)?.textContent ??
    ""
  );
}

function callsTo(method: string): string[] {
  return dom.calls
    .filter((call) => call.method === method)
    .map((call) => call.path);
}

async function clickButton(name: string): Promise<void> {
  const found = await dom.waitFor(() => dom.button(name));
  await dom.click(found);
}

/** Renames a page through its row menu and the inline title field. */
async function renameFromMenu(title: string, next: string): Promise<void> {
  await clickButton(`Actions for ${title}`);
  await clickButton("Rename");
  const field = await dom.waitFor(() => dom.field("Rename page"));
  await dom.type(field, next);
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
}

beforeEach(() => {
  dom = createTestDom();
  mounts = 0;
  dom.route("GET", "/api/me", () => ({ body: ME }));
  dom.route("GET", `${SPACE}/frontend`, () => ({ body: { editors: [] } }));
  routeSpace("main", "", "r1");
  routeSpace("cr/1", CR, "r1");
});

afterEach(async () => {
  await dom.dispose();
});

describe("SpaceView on a branch", () => {
  it("loads the space and the page from ?branch= and keeps it in links", async () => {
    visit(`/orgs/o1/spaces/s1/pages/p1?${CR}`);
    const seen: { branch: string; entryId: string }[] = [];
    await renderApp();
    ui.registerSlot("page.header", {
      id: "probe",
      component: (props) => {
        seen.push({ branch: props.branch, entryId: props.entryId });
        return (
          <button type="button" onClick={() => props.openBranch("main")}>
            Leave
          </button>
        );
      },
    });

    await dom.waitFor(() => output("Editor branch") === "cr/1");
    expect(callsTo("GET")).toContain(`${SPACE}?${CR}`);
    expect(callsTo("GET")).toContain(`${PAGE}?${CR}`);
    // A branch is edit mode; without a plugin's bar item the bar names it.
    expect(dom.container.querySelector(".bar .tag")?.textContent).toBe("cr/1");
    expect(dom.button("Done")).toBeDefined();
    const link = [...dom.container.querySelectorAll("nav a")].find(
      (anchor) => anchor.textContent === "Intro",
    );
    expect(link?.getAttribute("href")).toBe(
      `/orgs/o1/spaces/s1/pages/p1?${CR}`,
    );
    await dom.waitFor(() => seen.length > 0);
    expect(seen.at(-1)).toEqual({ branch: "cr/1", entryId: "p1" });

    await clickButton("Leave");
    await dom.waitFor(() => output("Editor branch") === "main");
    expect(currentPath()).toBe("/orgs/o1/spaces/s1/pages/p1");
    expect(dom.button("Done")).toBeUndefined();
    expect(dom.button("Edit")).toBeDefined();
    expect(output("Editor mount")).toBe("2");
  });

  it("keeps the branch on the way back from space settings", async () => {
    visit(`/orgs/o1/spaces/s1/settings?${CR}`);
    dom.route("GET", `${SPACE}/site`, () => ({
      body: { site: null, canPublish: true, head: "r1" },
    }));
    await renderApp();
    const back = await dom.waitFor(() =>
      [...dom.container.querySelectorAll<HTMLElement>(".bar a")].find(
        (anchor) => anchor.textContent === "Back to pages",
      ),
    );
    expect(back.getAttribute("href")).toBe(`/orgs/o1/spaces/s1?${CR}`);
    const intro = [...dom.container.querySelectorAll("nav a")].find(
      (anchor) => anchor.textContent === "Intro",
    );
    expect(intro?.getAttribute("href")).toBe(
      `/orgs/o1/spaces/s1/pages/p1?${CR}`,
    );
  });

  it("moves the first body save on main to the resolved branch without remounting the editor", async () => {
    visit("/orgs/o1/spaces/s1/pages/p1");
    const asked: (string | undefined)[] = [];
    const saves: { path: string; base: unknown }[] = [];
    let heads = 1;
    dom.route("PUT", `${PAGE}/body?${CR}`, (call) => {
      saves.push({
        path: call.path,
        base: (call.body as { base: unknown }).base,
      });
      return { body: { head: `r${++heads}` } };
    });
    await renderApp();
    ui.registerEditBranch(async (context) => {
      asked.push(context.entryId);
      return "cr/1";
    });
    await dom.waitFor(() => output("Editor branch") === "main");

    await clickButton("Save one");
    await clickButton("Save two");
    await dom.waitFor(() => output("Save status") === "saved two");
    await dom.waitFor(() => output("Editor branch") === "cr/1");

    expect(asked).toEqual(["p1"]);
    expect(currentPath()).toBe(`/orgs/o1/spaces/s1/pages/p1?${CR}`);
    expect(saves.map((save) => save.base)).toEqual(["r1", "r2"]);
    expect(callsTo("PUT").every((path) => path.endsWith(`?${CR}`))).toBe(true);
    expect(output("Editor mount")).toBe("1");
    expect(callsTo("GET")).toContain(`${PAGE}?${CR}`);

    // The branch's reload answered an older head; the next save must still
    // be based on the head the last save returned.
    await clickButton("Save one");
    await dom.waitFor(() => saves.length === 3);
    expect(saves[2]?.base).toBe("r3");
    expect(output("Editor mount")).toBe("1");
  });

  it("creates a page on the resolved branch and opens it there", async () => {
    visit("/orgs/o1/spaces/s1");
    dom.route("POST", `${SPACE}/pages?${CR}`, () => ({
      status: 201,
      body: { page: { id: "p1" }, head: "r2" },
    }));
    await renderApp();
    const asked: (string | undefined)[] = [];
    ui.registerEditBranch(async (context) => {
      asked.push(context.entryId);
      return "cr/1";
    });

    await clickButton("+ New page");
    await dom.waitFor(() => output("Editor branch") === "cr/1");
    expect(asked).toEqual([undefined]);
    expect(callsTo("POST")).toEqual([`${SPACE}/pages?${CR}`]);
    expect(currentPath()).toBe(`/orgs/o1/spaces/s1/pages/p1?${CR}`);
  });

  it("keeps writes on main when no resolver chooses a branch", async () => {
    visit("/orgs/o1/spaces/s1/pages/p1?edit=1");
    dom.route("PUT", `${PAGE}/body`, () => ({ body: { head: "r2" } }));
    dom.route("PATCH", PAGE, () => ({
      body: { page: { id: "p1" }, head: "r3" },
    }));
    await renderApp();
    await dom.waitFor(() => output("Editor branch") === "main");

    await clickButton("Save one");
    await dom.waitFor(() => output("Save status") === "saved one");
    await renameFromMenu("Intro", "Start");
    await dom.waitFor(() => callsTo("PATCH").length === 1);
    expect(callsTo("PUT")).toEqual([`${PAGE}/body`]);
    expect(callsTo("PATCH")).toEqual([PAGE]);
    expect(currentPath()).toBe("/orgs/o1/spaces/s1/pages/p1?edit=1");
    expect(output("Editor branch")).toBe("main");
  });

  it("renames on the resolved branch and asks once per visit", async () => {
    visit("/orgs/o1/spaces/s1/pages/p1");
    let asked = 0;
    dom.route("PATCH", `${PAGE}?${CR}`, () => ({
      body: { page: { id: "p1" }, head: "r2" },
    }));
    await renderApp();
    ui.registerEditBranch(async () => {
      asked++;
      return "cr/1";
    });
    await renameFromMenu("Intro", "Start");
    await dom.waitFor(() => output("Editor branch") === "cr/1");
    expect(callsTo("PATCH")).toEqual([`${PAGE}?${CR}`]);
    expect(asked).toBe(1);
  });

  it("shows a resolver's error and does not write", async () => {
    visit("/orgs/o1/spaces/s1/pages/p1");
    await renderApp();
    ui.registerEditBranch(async () => {
      throw new Error("could not start a change request");
    });
    await clickButton("Save one");
    await dom.waitFor(
      () => output("Save status") === "failed could not start a change request",
    );
    expect(callsTo("PUT")).toEqual([]);
    expect(currentPath()).toBe("/orgs/o1/spaces/s1/pages/p1");
  });

  it("shows the message of a rejected commit", async () => {
    visit("/orgs/o1/spaces/s1/pages/p1");
    dom.route("PATCH", PAGE, () => ({
      status: 409,
      body: {
        code: "change-requests/commit-rejected",
        message: "this space uses change requests; edit in a change request",
      },
    }));
    await renderApp();
    await renameFromMenu("Intro", "Start");
    const toast = await dom.waitFor(() =>
      document.querySelector('.toast[role="status"]'),
    );
    expect(toast.textContent).toBe(
      "this space uses change requests; edit in a change request",
    );
  });
});
