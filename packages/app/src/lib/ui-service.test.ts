import { Context } from "@docleus/sdk";
import { describe, expect, it, vi } from "vitest";
import { createUiService } from "./ui-service.ts";

const Noop = () => null;
const search = async () => [];

describe("createUiService", () => {
  it("orders slot items and removes them when their plugin unloads", async () => {
    const root = new Context();
    const ui = createUiService(root);
    root.provide("ui", ui);
    let changes = 0;
    ui.subscribe(() => changes++);

    const fiber = await root.plugin({
      inject: ["ui"],
      apply(ctx: Context) {
        ctx.ui.registerSlot("sidebar", { id: "b", order: 2, component: Noop });
        ctx.ui.registerSlot("sidebar", { id: "a", order: 1, component: Noop });
      },
    });
    expect(ui.slot("sidebar").map((item) => item.id)).toEqual(["a", "b"]);
    expect(changes).toBe(2);

    await fiber.dispose();
    expect(ui.slot("sidebar")).toEqual([]);
    expect(changes).toBe(4);
  });

  it("rejects a duplicate id in the same slot", () => {
    const root = new Context();
    const ui = createUiService(root);
    ui.registerSlot("sidebar", { id: "a", component: Noop });
    expect(() =>
      ui.registerSlot("sidebar", { id: "a", component: Noop }),
    ).toThrow(expect.objectContaining({ code: "ui/already-registered" }));
  });

  it("asks edit-branch resolvers in order and drops them on unload", async () => {
    const root = new Context();
    const ui = createUiService(root);
    root.provide("ui", ui);
    const asked: string[] = [];
    const context = { orgId: "o1", spaceId: "s1", entryId: "p1" };

    expect(await ui.resolveEditBranch(context)).toBeUndefined();
    const fiber = await root.plugin({
      inject: ["ui"],
      apply(ctx: Context) {
        ctx.ui.registerEditBranch(async () => {
          asked.push("first");
          return undefined;
        });
        ctx.ui.registerEditBranch(async (input) => {
          asked.push(`second ${input.entryId ?? ""}`);
          return "cr/1";
        });
      },
    });
    ui.registerEditBranch(async () => {
      asked.push("third");
      return "other";
    });

    expect(await ui.resolveEditBranch(context)).toBe("cr/1");
    expect(asked).toEqual(["first", "second p1"]);

    await fiber.dispose();
    asked.length = 0;
    expect(await ui.resolveEditBranch(context)).toBe("other");
    expect(asked).toEqual(["third"]);
  });

  it("rejects the resolution when a resolver throws", async () => {
    const root = new Context();
    const ui = createUiService(root);
    const later = vi.fn(async () => "cr/1");
    ui.registerEditBranch(async () => {
      throw new Error("no change request");
    });
    ui.registerEditBranch(later);
    await expect(
      ui.resolveEditBranch({ orgId: "o1", spaceId: "s1", entryId: undefined }),
    ).rejects.toThrow("no change request");
    expect(later).not.toHaveBeenCalled();
  });

  it("filters settings pages and apps", () => {
    const root = new Context();
    const ui = createUiService(root);
    ui.registerSettingsPage({
      id: "x",
      label: "X",
      scopes: ["org"],
      component: Noop,
    });
    ui.registerApp({ path: "board", label: "Board", component: Noop });
    expect(ui.settingsPages().map((page) => page.id)).toEqual(["x"]);
    expect(ui.apps().map((app) => app.path)).toEqual(["board"]);
  });

  it("keeps commands, search providers and draft finders until their plugin unloads", async () => {
    const root = new Context();
    const ui = createUiService(root);
    root.provide("ui", ui);
    const fiber = await root.plugin({
      inject: ["ui"],
      apply(ctx: Context) {
        ctx.ui.registerCommand({
          id: "x.go",
          label: "Go",
          run: () => undefined,
        });
        ctx.ui.registerSearch(search);
        ctx.ui.registerEditDraft(async () => ({
          branch: "cr/4",
          label: "Draft #4",
        }));
      },
    });
    expect(ui.commands().map((command) => command.id)).toEqual(["x.go"]);
    expect(ui.searchProviders()).toEqual([search]);
    expect(await ui.findEditDraft({ orgId: "o", spaceId: "s" })).toEqual({
      branch: "cr/4",
      label: "Draft #4",
    });
    expect(() =>
      ui.registerCommand({ id: "x.go", label: "Again", run: () => undefined }),
    ).toThrow(expect.objectContaining({ code: "ui/already-registered" }));

    await fiber.dispose();
    expect(ui.commands()).toEqual([]);
    expect(ui.searchProviders()).toEqual([]);
    expect(
      await ui.findEditDraft({ orgId: "o", spaceId: "s" }),
    ).toBeUndefined();
  });

  it("skips a draft finder that throws", async () => {
    const ui = createUiService(new Context());
    ui.registerEditDraft(async () => {
      throw new Error("offline");
    });
    ui.registerEditDraft(async () => ({ branch: "cr/2", label: "Draft #2" }));
    expect(await ui.findEditDraft({ orgId: "o", spaceId: "s" })).toMatchObject({
      branch: "cr/2",
    });
  });

  it("passes notices to every listener", () => {
    const ui = createUiService(new Context());
    const heard: string[] = [];
    const stop = ui.onNotice((notice) => heard.push(notice.message));
    ui.notify({ message: "Merged #4" });
    stop();
    ui.notify({ message: "unheard" });
    expect(heard).toEqual(["Merged #4"]);
  });
});
