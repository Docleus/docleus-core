import type { BlockRenderer, RenderService } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { renderConformanceSuite } from "./render.ts";

function unsupported(): never {
  throw new Error("not supported by the broken implementation");
}

/** Violates "the placeholder escapes the block type": interpolates it raw. */
function createBrokenRenderService(): RenderService {
  const renderers = new Map<string, BlockRenderer>();
  const service: RenderService = {
    registerBlock(type, renderer) {
      if (renderers.has(type)) throw new Error(`"${type}" is registered`);
      renderers.set(type, renderer);
      return () => renderers.delete(type);
    },
    render(node) {
      const renderer = renderers.get(node.type);
      if (!renderer) {
        return {
          html: `<div data-unknown-block="${node.type}"></div>`,
          islands: [],
        };
      }
      return renderer(node, {
        anchor: (text) => text,
        children: (parent) => {
          const results = (parent.content ?? []).map((child) =>
            service.render(child),
          );
          return {
            html: results.map((result) => result.html).join(""),
            islands: results.flatMap((result) => result.islands),
          };
        },
      });
    },
    registerTheme: unsupported,
    resolveTheme: () => undefined,
    registerSlot: unsupported,
    registerFile: unsupported,
    renderPage: unsupported,
    renderFiles: () => new Map(),
  };
  return service;
}

describe("a deliberately broken render implementation", () => {
  it("fails the escaping invariant the suite is meant to catch", async () => {
    const invariant = renderConformanceSuite.invariants.find(
      (candidate) =>
        candidate.name ===
        "the placeholder escapes the block type so it cannot inject markup",
    );
    if (!invariant) throw new Error("expected the invariant to exist");
    await expect(
      Promise.resolve().then(() =>
        invariant.check(createBrokenRenderService()),
      ),
    ).rejects.toThrow();
  });
});
