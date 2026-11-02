import { DocleusError } from "@docleus/kernel";
import { MAIN_BRANCH, toEditorDocument, type BlockNode } from "@docleus/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Instance } from "../src/index.ts";
import { account, bootWith, type Account } from "./helpers.ts";

const instances: Instance[] = [];
const boot = bootWith(instances);

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

interface PageResponse {
  page: { id: string; title: string; body: BlockNode };
  head: string;
}

interface SpaceResponse {
  branch: { name: string; head?: string };
  head: { id: string } | null;
  pages: { id: string; title: string }[];
}

async function withBranch(): Promise<{
  instance: Instance;
  admin: Account;
  spaceId: string;
  space: string;
}> {
  const instance = await boot();
  const admin = await account(instance, "admin@example.com", { isAdmin: true });
  const { org } = await admin.api.json<{ org: { id: string } }>(
    "POST",
    "/api/orgs",
    { slug: "acme", name: "Acme" },
  );
  const { space } = await admin.api.json<{ space: { id: string } }>(
    "POST",
    `/api/orgs/${org.id}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  await admin.api.json("POST", `/api/orgs/${org.id}/spaces/${space.id}/pages`, {
    title: "Intro",
  });
  await instance.ctx.content.createBranch({
    spaceId: space.id,
    name: "feature",
  });
  return {
    instance,
    admin,
    spaceId: space.id,
    space: `/api/orgs/${org.id}/spaces/${space.id}`,
  };
}

const titles = (response: SpaceResponse) =>
  response.pages.map((page) => page.title).toSorted();

describe("branches API", () => {
  it("reads main by default and names the branch in GET space", async () => {
    const { admin, space } = await withBranch();
    const main = await admin.api.json<SpaceResponse>("GET", space);
    expect(main.branch.name).toBe(MAIN_BRANCH);
    expect(titles(main)).toEqual(["Intro"]);
    const feature = await admin.api.json<SpaceResponse>(
      "GET",
      `${space}?branch=feature`,
    );
    expect(feature.branch.name).toBe("feature");
    expect(feature.head?.id).toBe(main.head?.id);
  });

  it("lists branches with main first", async () => {
    const { admin, space } = await withBranch();
    const { branches } = await admin.api.json<{
      branches: { name: string }[];
    }>("GET", `${space}/branches`);
    expect(branches.map((branch) => branch.name)).toEqual([
      MAIN_BRANCH,
      "feature",
    ]);
  });

  it("edits pages on a branch without touching main", async () => {
    const { admin, space } = await withBranch();
    const feature = `?branch=feature`;
    const created = await admin.api.json<PageResponse>(
      "POST",
      `${space}/pages${feature}`,
      { title: "Draft" },
    );
    const [intro] = (
      await admin.api.json<SpaceResponse>("GET", `${space}${feature}`)
    ).pages.filter((page) => page.title === "Intro");
    if (!intro) throw new Error("expected the Intro page");
    await admin.api.json("PATCH", `${space}/pages/${intro.id}${feature}`, {
      title: "Intro 2",
    });
    const loaded = await admin.api.json<PageResponse>(
      "GET",
      `${space}/pages/${created.page.id}${feature}`,
    );
    await admin.api.json(
      "PUT",
      `${space}/pages/${created.page.id}/body${feature}`,
      { base: loaded.head, document: toEditorDocument(loaded.page.body) },
    );

    expect(
      titles(await admin.api.json<SpaceResponse>("GET", `${space}${feature}`)),
    ).toEqual(["Draft", "Intro 2"]);
    expect(titles(await admin.api.json<SpaceResponse>("GET", space))).toEqual([
      "Intro",
    ]);
    expect(
      (await admin.api.call("GET", `${space}/pages/${created.page.id}`)).status,
    ).toBe(404);

    await admin.api.json("DELETE", `${space}/pages/${intro.id}${feature}`);
    expect(
      titles(await admin.api.json<SpaceResponse>("GET", `${space}${feature}`)),
    ).toEqual(["Draft"]);
    expect(titles(await admin.api.json<SpaceResponse>("GET", space))).toEqual([
      "Intro",
    ]);
  });

  it("answers 404 for an unknown branch on every space route", async () => {
    const { admin, space } = await withBranch();
    const { pages } = await admin.api.json<SpaceResponse>("GET", space);
    const pageId = pages[0]?.id ?? "";
    const routes: [string, string, unknown?][] = [
      ["GET", `${space}?branch=nope`],
      ["POST", `${space}/pages?branch=nope`, { title: "X" }],
      ["GET", `${space}/pages/${pageId}?branch=nope`],
      ["PATCH", `${space}/pages/${pageId}?branch=nope`, { title: "X" }],
      ["DELETE", `${space}/pages/${pageId}?branch=nope`],
      [
        "PUT",
        `${space}/pages/${pageId}/body?branch=nope`,
        { base: null, document: {} },
      ],
    ];
    for (const [method, path, body] of routes) {
      const response = await admin.api.call(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "api/branch-not-found",
      });
    }
  });

  it("records the signed-in user as the author of each commit", async () => {
    const { instance, admin, space, spaceId } = await withBranch();
    const created = await admin.api.json<PageResponse>(
      "POST",
      `${space}/pages?branch=feature`,
      { title: "Draft" },
    );
    const revision = await instance.ctx.content.getRevision(created.head);
    expect(revision).toMatchObject({ branch: "feature", author: admin.id });
    const main = await instance.ctx.content.head(spaceId);
    expect(main?.author).toBe(admin.id);
  });

  it("answers 409 when a pre-commit listener rejects the commit", async () => {
    const { instance, admin, space } = await withBranch();
    instance.ctx.on("content/pre-commit", () => {
      throw new DocleusError("acme/commit-rejected", "frozen");
    });
    const response = await admin.api.call("POST", `${space}/pages`, {
      title: "Blocked",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "acme/commit-rejected",
      message: "frozen",
    });
  });

  it("maps branch and merge error codes to HTTP statuses", async () => {
    const { instance, admin, space } = await withBranch();
    const cases: [string, number][] = [
      ["content/branch-taken", 409],
      ["content/invalid-branch", 400],
      ["content/merge-conflict", 409],
      ["content/invalid-resolution", 400],
      ["acme/not-allowed", 403],
    ];
    for (const [code, status] of cases) {
      const dispose = instance.ctx.on("content/pre-commit", () => {
        throw new DocleusError(code, code);
      });
      const response = await admin.api.call("POST", `${space}/pages`, {
        title: "X",
      });
      expect(response.status, code).toBe(status);
      dispose();
    }
  });
});
