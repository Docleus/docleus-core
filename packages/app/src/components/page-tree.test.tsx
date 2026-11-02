import { Context, MAIN_BRANCH } from "@docleus/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostContext, type Host } from "../lib/host.tsx";
import type { PageSummary } from "../lib/page-tree.ts";
import { createToastStore } from "../lib/toasts.ts";
import { createUiService } from "../lib/ui-service.ts";
import {
  createTestDom,
  currentPath,
  visit,
  type TestDom,
} from "../test-dom.tsx";
import { PageTree, type PageTreeProps } from "./page-tree.tsx";

const PAGES = [
  { id: "parent", title: "Parent", parent: null, order: 1 },
  { id: "child", title: "Child", parent: "parent", order: 1 },
  { id: "other", title: "Other", parent: null, order: 2 },
];

let dom: TestDom;
let host: Host;

beforeEach(() => {
  sessionStorage.clear();
  dom = createTestDom();
  const root = new Context();
  host = {
    root,
    ui: createUiService(root),
    loader: { urls: [], apply: async () => undefined },
    toasts: createToastStore(),
  };
});

afterEach(async () => {
  await dom.dispose();
});

async function render(
  currentId: string,
  pages: readonly PageSummary[] = PAGES,
): Promise<void> {
  const props: PageTreeProps = {
    spaceId: "s1",
    base: "/orgs/o1/spaces/s1",
    apiBase: "/api/orgs/o1/spaces/s1",
    branch: MAIN_BRANCH,
    pages,
    mainPages: undefined,
    currentId,
    canWrite: true,
    isEditing: false,
    write: (_entryId, action) => action(MAIN_BRANCH),
    openNew: () => undefined,
  };
  await dom.render(
    <HostContext value={host}>
      <PageTree {...props} />
    </HostContext>,
  );
}

const titles = () =>
  [...dom.container.querySelectorAll(".trow > a")].map((a) => a.textContent);

describe("PageTree", () => {
  it("opens to the current page", async () => {
    await render("child");
    expect(titles()).toEqual(["Parent", "Child", "Other"]);
  });

  it("opens new ancestors when the current page moves", async () => {
    await render("other");
    expect(titles()).toEqual(["Parent", "Other"]);
    await render(
      "other",
      PAGES.map((page) =>
        page.id === "other" ? { ...page, parent: "child" } : page,
      ),
    );
    expect(titles()).toEqual(["Parent", "Child", "Other"]);
  });

  it("opens new ancestors when the current page's parent moves", async () => {
    await render("child");
    await render(
      "child",
      PAGES.map((page) =>
        page.id === "parent" ? { ...page, parent: "other" } : page,
      ),
    );
    expect(titles()).toEqual(["Other", "Parent", "Child"]);
  });

  it("collapsing the parent of the current page opens the parent", async () => {
    await render("child");
    await dom.click(dom.button("Toggle Parent") as HTMLButtonElement);
    expect(titles()).toEqual(["Parent", "Other"]);
    expect(dom.button("Toggle Parent")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(currentPath()).toBe("/orgs/o1/spaces/s1/pages/parent");
    // The parent is now current, so the tree leaves it collapsed.
    await render("parent");
    expect(titles()).toEqual(["Parent", "Other"]);
  });

  it("collapsing another page keeps the current one", async () => {
    visit("/orgs/o1/spaces/s1/pages/other");
    await render("other");
    await dom.click(dom.button("Toggle Parent") as HTMLButtonElement);
    await dom.click(dom.button("Toggle Parent") as HTMLButtonElement);
    expect(titles()).toEqual(["Parent", "Other"]);
    expect(currentPath()).toBe("/orgs/o1/spaces/s1/pages/other");
  });

  it("opens again when a page inside it becomes current", async () => {
    await render("child");
    await dom.click(dom.button("Toggle Parent") as HTMLButtonElement);
    await render("parent");
    await render("child");
    expect(titles()).toEqual(["Parent", "Child", "Other"]);
  });
});
